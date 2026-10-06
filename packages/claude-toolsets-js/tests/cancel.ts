#!/usr/bin/env bun
/**
 * Live checks that a stopped run stops long actions at once: no model, an E2B key only.
 *
 *     pnpm -F @e2b/claude-toolsets exercise:cancel
 *
 * The tool runner passes its abort signal to each call. Each check starts a 20 s `wait` or `hold_key` through
 * `run()`, the entry point the runner uses, aborts after 1 s, and expects the call to end within a few seconds, with
 * the held key released. The desktop is killed at the end; the script exits non-zero if a check failed.
 */
import { performance } from 'node:perf_hooks';
import { Sandbox } from '@e2b/desktop';
import { E2BBrowserToolset, E2BComputerToolset, allowHosts } from '../src/index.ts';

let failed = 0;
let id = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failed++;
  console.log(`   ${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` · ${detail}` : ''}`);
};

/**
 * Run one member with a signal that aborts after 1 s, calling `during` halfway. Returns how long it took and how it
 * ended (the error's name and message, or "finished").
 */
async function abortAfterOneSecond(
  t: E2BBrowserToolset | E2BComputerToolset,
  name: string,
  input: object,
  during?: () => Promise<void>,
) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 1_000);
  const halfway = during ? new Promise((r) => setTimeout(r, 500)).then(during) : Promise.resolve();
  const started = performance.now();
  const use = { type: 'tool_use', id: `x_${++id}`, toolset_name: t.toolsetName, name, input };
  const outcome = await t.run({ signal: controller.signal } as never, use as never).then(
    () => 'finished',
    (e: Error) => `${e.name}: ${e.message}`,
  );
  const seconds = (performance.now() - started) / 1000;
  await halfway;
  return { seconds, outcome };
}
/** Ended by the abort, about 1 s in: not finished, not refused at once, not some other failure. */
const stoppedByAbort = (r: { seconds: number; outcome: string }) =>
  r.seconds >= 0.9 && r.seconds < 4 && /abort/i.test(r.outcome);

const desktop = await Sandbox.create({
  resolution: [1280, 800],
  timeoutMs: 300_000,
  network: { allowPublicTraffic: false, maskRequestHost: 'localhost:${PORT}' },
});
try {
  console.log('Computer toolset');
  const computer = await E2BComputerToolset.create(desktop, { confirm: () => true });
  const shift = async () =>
    (
      await desktop.commands.run(
        'xinput --query-state "Virtual core XTEST keyboard" | grep -o "key\\[50\\]=[a-z]*" || true',
        {
          envs: { DISPLAY: ':0' },
        },
      )
    ).stdout.trim() || 'key[50]=up'; // xinput lists only keys that are down on some setups
  let r = await abortAfterOneSecond(computer, 'wait', { duration: 20 });
  check(stoppedByAbort(r), 'wait 20 s stops when the run is stopped', `${r.seconds.toFixed(1)} s, ${r.outcome}`);
  let held = '';
  r = await abortAfterOneSecond(computer, 'hold_key', { text: 'shift', duration: 20 }, async () => {
    held = await shift();
  });
  check(held === 'key[50]=down', 'Shift is down while hold_key runs', held);
  check(stoppedByAbort(r), 'hold_key 20 s stops when the run is stopped', `${r.seconds.toFixed(1)} s, ${r.outcome}`);
  check((await shift()) === 'key[50]=up', 'Shift is released after the stop', await shift());
  let t = performance.now();
  await computer.close();
  check(
    performance.now() - t < 4_000,
    'close() right after does not wait',
    `${((performance.now() - t) / 1000).toFixed(1)} s`,
  );

  console.log('Browser toolset');
  const browser = await E2BBrowserToolset.create({
    sandbox: desktop,
    urlPolicy: allowHosts(['example.com']),
    configs: { javascript_exec: { enabled: true } },
    confirm: () => true, // throwaway sandbox: approve the page scripts this check runs
  });
  const js = async (text: string) => {
    const r = await browser.toolResult({
      type: 'tool_use',
      id: `x_${++id}`,
      toolset_name: 'browser',
      name: 'javascript_exec',
      input: { text },
    } as never);
    return JSON.stringify(r.content);
  };
  await browser.toolResult({
    type: 'tool_use',
    id: `x_${++id}`,
    toolset_name: 'browser',
    name: 'navigate',
    input: { url: 'https://example.com' },
  } as never);
  await js("window.ups = 0; addEventListener('keyup', (e) => { if (e.key === 'Shift') window.ups++ }); 'ok'");
  r = await abortAfterOneSecond(browser, 'hold_key', { text: 'shift', duration: 20 });
  check(stoppedByAbort(r), 'hold_key 20 s stops when the run is stopped', `${r.seconds.toFixed(1)} s, ${r.outcome}`);
  check(/"1"/.test(await js('String(window.ups)')), 'the page saw Shift released');
  t = performance.now();
  await browser.close();
  check(
    performance.now() - t < 4_000,
    'close() right after does not wait',
    `${((performance.now() - t) / 1000).toFixed(1)} s`,
  );
} catch (error) {
  failed++;
  console.log(`   ERROR ${(error as Error).stack ?? error}`);
} finally {
  await desktop.kill().catch(() => undefined);
  console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
  process.exitCode = failed ? 1 : 0;
}
