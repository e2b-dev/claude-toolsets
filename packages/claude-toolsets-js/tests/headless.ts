#!/usr/bin/env bun
/**
 * Live check of where Chrome shows: no model, an E2B key only.
 *
 *     pnpm -F @e2b/claude-toolsets exercise:headless
 *
 * On an @e2b/desktop sandbox with no options, Chrome opens a visible window on the desktop's screen; with
 * `headless: true` it runs headless with no window. The desktop is killed at the end.
 */
import { Sandbox } from '@e2b/desktop';
import { E2BBrowserToolset, allowHosts } from '../src/index.ts';

let failed = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failed++;
  console.log(`   ${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` · ${detail}` : ''}`);
};
const desktop = await Sandbox.create({
  timeoutMs: 300_000,
  network: { allowPublicTraffic: false, maskRequestHost: 'localhost:${PORT}' },
});
const windows = async () =>
  (
    await desktop.commands.run('xdotool search --onlyvisible --class chrome 2>/dev/null | wc -l', {
      envs: { DISPLAY: ':0' },
    })
  ).stdout.trim();
const headlessFlag = async () =>
  (
    await desktop.commands.run("pgrep -fa '[c]hrome.*--remote-debugging-port' | grep -c -- '--headless' || true")
  ).stdout.trim();
try {
  for (const [label, options] of [
    ['default on a desktop', {}],
    ['headless: true', { headless: true }],
  ] as const) {
    const browser = await E2BBrowserToolset.create({
      sandbox: desktop,
      urlPolicy: allowHosts(['example.com']),
      ...options,
    });
    const visible = label === 'default on a desktop';
    check((await headlessFlag()) === (visible ? '0' : '1'), `${label}: Chrome ${visible ? 'is not' : 'is'} --headless`);
    check(
      visible ? Number(await windows()) > 0 : (await windows()) === '0',
      `${label}: ${visible ? 'a window is on screen :0' : 'no window on screen'}`,
      `${await windows()} window(s)`,
    );
    await browser.close();
    for (let i = 0; i < 20 && (await headlessFlag()) !== '0'; i++) await new Promise((r) => setTimeout(r, 250));
  }
} catch (error) {
  failed++;
  console.log(`   ERROR ${(error as Error).stack ?? error}`);
} finally {
  await desktop.kill().catch(() => undefined);
  console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
  process.exitCode = failed ? 1 : 0;
}
