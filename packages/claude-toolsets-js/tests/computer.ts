#!/usr/bin/env bun
/**
 * Exercise the E2B computer toolset with the calls a model would make, on a stock desktop: no model, an E2B key only.
 *
 *     pnpm -F @e2b/claude-toolsets exercise:computer
 *
 * Each call goes through `toolResult()`, the same pipeline the tool runner uses. It covers every member the driver
 * implements, and the refusals: out-of-range durations, repeats and scrolls are refused (never silently capped), as
 * are coordinates off the screen and key names that are not plain keys. The desktop is killed at the end; the script
 * exits non-zero if a check failed.
 */
import { Sandbox } from '@e2b/desktop';
import { E2BComputerToolset } from '../src/index.ts';

let failed = 0;
let id = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failed++;
  console.log(`   ${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` · ${detail}` : ''}`);
};

const desktop = await Sandbox.create({ resolution: [1280, 800], timeoutMs: 300_000 });
try {
  // confirm: required by the SDK for key, type and hold_key; this throwaway desktop approves every call
  const computer = await E2BComputerToolset.create(desktop, { confirm: () => true });
  const call = async (name: string, input: Record<string, unknown> = {}) => {
    const r = await computer.toolResult({
      type: 'tool_use',
      id: `c_${++id}`,
      toolset_name: 'computer',
      name,
      input,
    } as never);
    const blocks = typeof r.content === 'string' ? [{ type: 'text', text: r.content }] : (r.content ?? []);
    const text = blocks
      .map((b: any) => (b.type === 'text' ? b.text : `[${b.type}]`))
      .join(' ')
      .replace(/\s+/g, ' ');
    return { error: !!r.is_error, text: text.slice(0, 100), image: blocks.some((b: any) => b.type === 'image') };
  };
  const ok = async (what: string, name: string, input?: Record<string, unknown>) => {
    const r = await call(name, input);
    check(!r.error, what, r.text);
    return r;
  };
  const refused = async (what: string, name: string, input: Record<string, unknown>, message: RegExp) => {
    const r = await call(name, input);
    check(r.error && message.test(r.text), what, r.text);
  };

  console.log('Members');
  check((await ok('screenshot', 'screenshot')).image, 'screenshot returns an image');
  await ok('cursor_position', 'cursor_position');
  await ok('mouse_move', 'mouse_move', { coordinate: [640, 400] });
  await ok('left_click', 'left_click', { coordinate: [640, 400] });
  await ok('left_click with a held modifier', 'left_click', { coordinate: [640, 400], text: 'shift' });
  await ok('right_click', 'right_click', { coordinate: [640, 400] });
  await ok('key Escape (closes the menu)', 'key', { text: 'Escape' });
  await ok('double_click', 'double_click', { coordinate: [640, 400] });
  await ok('triple_click', 'triple_click', { coordinate: [640, 400] });
  await ok('middle_click', 'middle_click', { coordinate: [640, 400] });
  await ok('left_click_drag', 'left_click_drag', { start_coordinate: [600, 400], coordinate: [700, 450] });
  await ok('left_mouse_down', 'left_mouse_down');
  await ok('left_mouse_up', 'left_mouse_up');
  await ok('scroll 3', 'scroll', { coordinate: [640, 400], scroll_direction: 'down', scroll_amount: 3 });
  await ok('scroll 50 (the limit)', 'scroll', { scroll_direction: 'up', scroll_amount: 50 });
  await ok('type', 'type', { text: 'hello' });
  await ok('key with repeat', 'key', { text: 'BackSpace', repeat: 5 });
  await ok('key chord', 'key', { text: 'ctrl+a' });
  const t = Date.now();
  await ok('hold_key 1 s', 'hold_key', { text: 'shift', duration: 1 });
  check(Date.now() - t >= 1000, 'hold_key held for the full duration', `${Date.now() - t} ms`);
  await ok('wait 1 s', 'wait', { duration: 1 });

  console.log('Refusals (refused, never silently capped)');
  await refused('hold_key over 30 s', 'hold_key', { text: 'shift', duration: 31 }, /between 0 and 30 seconds/);
  await refused('wait over 30 s', 'wait', { duration: 31 }, /between 0 and 30 seconds/);
  await refused('scroll over 50', 'scroll', { scroll_direction: 'down', scroll_amount: 51 }, /from 1 to 50/);
  await refused('scroll of 0', 'scroll', { scroll_direction: 'down', scroll_amount: 0 }, /from 1 to 50/);
  await refused('key repeat over 100', 'key', { text: 'a', repeat: 101 }, /from 1 to 100/);
  await refused('a click off the screen', 'left_click', { coordinate: [1280, 0] }, /outside the 1280x800 screen/);
  await refused('a key that is not a key name', 'key', { text: 'a;reboot' }, /not a key name/);
  await refused('zoom (not implemented)', 'zoom', { region: [0, 0, 100, 100] }, /not available|not enabled|unknown/i);

  console.log('close()');
  const button = async () =>
    (
      await desktop.commands.run('xinput --query-state "Virtual core XTEST pointer" | grep -o "button\\[1\\]=[a-z]*"', {
        envs: { DISPLAY: ':0' },
      })
    ).stdout.trim();
  // hold_key whose keydown goes through but its reply is lost, and whose keyup fails: close() must catch it
  const run = desktop.commands.run.bind(desktop.commands);
  const shift = async () =>
    (
      await run('xinput --query-state "Virtual core XTEST keyboard" | grep -o "key\\[50\\]=[a-z]*" || true', {
        envs: { DISPLAY: ':0' },
      })
    ).stdout.trim() || 'key[50]=up';
  desktop.commands.run = (async (command: string, opts?: never) => {
    if (command.includes('keydown')) {
      await run(command, opts);
      throw new Error('injected: reply lost');
    }
    if (command.includes('keyup')) throw new Error('injected: keyup failed');
    return run(command, opts);
  }) as never;
  await call('hold_key', { text: 'shift', duration: 1 });
  check((await shift()) === 'key[50]=down', 'Shift is left down when both replies fail', await shift());
  desktop.commands.run = run as never;
  // a Ctrl-click whose command stops part-way, and whose keyup fails too: close() must still release Ctrl
  const ctrl = async () =>
    (
      await run('xinput --query-state "Virtual core XTEST keyboard" | grep -o "key\\[37\\]=[a-z]*" || true', {
        envs: { DISPLAY: ':0' },
      })
    ).stdout.trim() || 'key[37]=up';
  desktop.commands.run = (async (command: string, opts?: never) => {
    if (command.includes('keydown ctrl') && command.includes('click')) {
      await run('xdotool keydown ctrl', opts);
      throw new Error('injected: command stopped part-way');
    }
    if (command.includes('keyup')) throw new Error('injected: keyup failed');
    return run(command, opts);
  }) as never;
  await call('left_click', { coordinate: [640, 400], text: 'ctrl' });
  check((await ctrl()) === 'key[37]=down', 'Ctrl is left down after a failed modifier click', await ctrl());
  desktop.commands.run = run as never;
  await ok('left_mouse_down, then close', 'left_mouse_down');
  check((await button()) === 'button[1]=down', 'the button is down', await button());
  await computer.close();
  check((await button()) === 'button[1]=up', 'close() released the held button', await button());
  check((await shift()) === 'key[50]=up', 'close() released the held Shift', await shift());
  check((await ctrl()) === 'key[37]=up', 'close() released the held Ctrl', await ctrl());
} catch (error) {
  failed++;
  console.log(`   ERROR ${(error as Error).stack ?? error}`);
} finally {
  await desktop.kill().catch(() => undefined);
  console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
  process.exitCode = failed ? 1 : 0;
}
