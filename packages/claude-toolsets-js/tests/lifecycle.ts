#!/usr/bin/env bun
/**
 * Live checks for cleanup and fail-closed behavior, with failures injected: no model, an E2B key only.
 *
 *     pnpm -F @e2b/claude-toolsets exercise:lifecycle
 *
 *   1. close() that fails part-way (the sandbox kill) throws, and a second close() finishes the job.
 *   2. Chrome the toolset started in an attached sandbox is stopped when the connection to it fails.
 *   3. A cross-site iframe whose interception cannot be set up does not keep running past the URL policy.
 * Every sandbox it creates is killed at the end; the script exits non-zero if a check failed.
 */
import { Sandbox } from '@e2b/desktop';
import { Sandbox as BaseSandbox } from 'e2b';
import { CdpClient } from '../src/cdp.ts';
import { BrowserInitializationError, E2BBrowserToolset, allowHosts, liveView } from '../src/index.ts';

const network = { allowPublicTraffic: false, maskRequestHost: 'localhost:${PORT}' };
const created: string[] = [];
let failed = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failed++;
  console.log(`   ${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` · ${detail}` : ''}`);
};
async function desktop() {
  const d = await Sandbox.create({ resolution: [1280, 800], timeoutMs: 600_000, network });
  created.push(d.sandboxId);
  return d;
}
const ourChromes = async (d: Sandbox) =>
  Number((await d.commands.run("pgrep -fc -- '[-]-user-data-dir=/tmp/e2b-browser-' || true")).stdout.trim());

try {
  console.log('1. close() retries what failed');
  {
    const browser = await E2BBrowserToolset.create({ urlPolicy: allowHosts(['example.com']) });
    const sandbox = browser.sandbox;
    created.push(sandbox.sandboxId);
    const kill = sandbox.kill.bind(sandbox);
    let calls = 0;
    sandbox.kill = (async () => {
      if (calls++ === 0) throw new Error('injected: kill failed');
      return kill();
    }) as typeof sandbox.kill;
    const first = await browser.close().then(
      () => '',
      (e: Error) => e.message,
    );
    check(/call close\(\) again/.test(first), 'first close() reports the failure', first);
    check(await sandbox.isRunning(), 'the sandbox is still running after the failed kill');
    const second = await browser.close().then(
      () => 'ok',
      (e: Error) => e.message,
    );
    check(second === 'ok', 'second close() succeeds', second);
    check(!(await sandbox.isRunning()), 'the sandbox is gone after the retry');
  }

  console.log('2. Chrome started in your sandbox is stopped when the connection fails');
  {
    const d = await desktop();
    const connect = CdpClient.connect;
    CdpClient.connect = async () => {
      throw new Error('injected: connection failed');
    };
    const error = await E2BBrowserToolset.create({ sandbox: d, urlPolicy: allowHosts(['example.com']) }).then(
      () => '',
      (e: Error) => e.message,
    );
    CdpClient.connect = connect;
    check(/injected/.test(error), 'create() reports the failed connection', error);
    check((await ourChromes(d)) === 0, 'no Chrome of ours left running in the sandbox');
    check(await d.isRunning(), 'your sandbox is left running');
  }

  console.log('3. An iframe that cannot be intercepted never runs past the URL policy');
  {
    const d = await desktop();
    // the iframe loads a beacon from port 8001, which the URL policy does not allow: it must never arrive
    await d.files.write(
      '/tmp/site/outer.html',
      '<title>outer</title><iframe src="http://127.0.0.1:8000/inner.html"></iframe>',
    );
    await d.files.write('/tmp/site/inner.html', '<title>inner</title><img src="http://127.0.0.1:8001/beacon.png">');
    await d.commands.run('cd /tmp/site && python3 -m http.server 8000 --bind 0.0.0.0', { background: true });
    await d.commands.run('cd /tmp && python3 -m http.server 8001 --bind 0.0.0.0 2>/tmp/beacon.log', {
      background: true,
    });
    const urlPolicy = allowHosts(['localhost:8000', '127.0.0.1:8000']);
    const iframes = async () =>
      ((await d.commands.run('curl -s 127.0.0.1:9222/json/list')).stdout.match(/"type": "iframe"/g) ?? []).length;
    const beacons = async () => Number((await d.commands.run('grep -c beacon /tmp/beacon.log || true')).stdout.trim());
    const navigate = (b: E2BBrowserToolset) =>
      b.toolResult({
        type: 'tool_use',
        id: `l_${Date.now()}`,
        toolset_name: 'browser',
        name: 'navigate',
        input: { url: 'http://localhost:8000/outer.html' },
      } as never);
    const settle = () => new Promise((r) => setTimeout(r, 2000));

    // baseline: the cross-site iframe runs in its own target, intercepted, so the beacon is refused
    const plain = await E2BBrowserToolset.create({ sandbox: d, urlPolicy });
    await navigate(plain);
    await settle();
    check((await iframes()) > 0, 'baseline: the cross-site iframe is its own target');
    check((await beacons()) === 0, 'baseline: its beacon is refused by the URL policy');
    await plain.close();
    for (let i = 0; i < 40 && (await ourChromes(d)) > 0; i++) await new Promise((r) => setTimeout(r, 250)); // let it exit

    for (const closeFails of [false, true]) {
      const label = closeFails ? 'when closing it fails too' : 'when interception fails';
      const browser = await E2BBrowserToolset.create({ sandbox: d, urlPolicy });
      const send = CdpClient.prototype.send;
      CdpClient.prototype.send = function (
        this: CdpClient,
        method: string,
        params?: never,
        sessionId?: string,
        t?: number,
      ) {
        // from now on interception cannot be set up for any new target (and, in the second run, nothing can be closed)
        if (method === 'Fetch.enable') return Promise.reject(new Error('injected: Fetch.enable failed'));
        if (closeFails && method === 'Target.closeTarget')
          return Promise.reject(new Error('injected: closeTarget failed'));
        return send.call(this, method, params, sessionId, t);
      } as typeof send;
      try {
        await navigate(browser);
        await settle();
        check(
          (await beacons()) === 0,
          `${label}: the iframe never sent its beacon`,
          `${await beacons()} beacon request(s)`,
        );
        // the iframe stays paused rather than closed: closing an iframe target in a visible Chrome closes its tab,
        // and with the last tab Chrome itself
        const pages = ((await d.commands.run('curl -s 127.0.0.1:9222/json/list')).stdout.match(/"type": "page"/g) ?? [])
          .length;
        check(
          pages > 0,
          `${label}: Chrome and the page are still there`,
          `${pages} page(s), ${await iframes()} iframe(s)`,
        );
      } finally {
        CdpClient.prototype.send = send;
        await browser.close().catch(() => undefined);
      }
      for (let i = 0; i < 40 && (await ourChromes(d)) > 0; i++) await new Promise((r) => setTimeout(r, 250));
    }
  }

  console.log('4. close() releases a mouse button held in a browser it did not start');
  {
    const d = await desktop();
    // the owner starts Chrome and watches the page; a second toolset borrows that Chrome
    const owner = await E2BBrowserToolset.create({
      sandbox: d,
      urlPolicy: allowHosts(['example.com']),
      configs: { javascript_exec: { enabled: true } },
      confirm: () => true, // throwaway sandbox: approve the page scripts this check runs
    });
    const run = async (b: E2BBrowserToolset, name: string, input: Record<string, unknown>) => {
      const r = await b.toolResult({
        type: 'tool_use',
        id: `l_${Date.now()}_${name}`,
        toolset_name: 'browser',
        name,
        input,
      } as never);
      return JSON.stringify(r.content);
    };
    await run(owner, 'navigate', { url: 'https://example.com' });
    await run(owner, 'javascript_exec', {
      text: "window.ups = 0; addEventListener('mouseup', () => window.ups++); 'ok'",
    });
    const borrower = await E2BBrowserToolset.create({ sandbox: d, urlPolicy: allowHosts(['example.com']) });
    await run(borrower, 'left_mouse_down', { target: { type: 'coordinate', x: 200, y: 200 } });
    await borrower.close();
    const ups = await run(owner, 'javascript_exec', { text: 'String(window.ups)' });
    check(/\b1\b/.test(ups), 'the page saw the button released when the borrower closed', ups.slice(0, 80));
    await owner.close();
  }

  console.log('5. liveView stops the stream it started, and refuses one already running');
  {
    const d = await desktop();
    const vnc = async () => (await d.commands.run('pgrep -xc x11vnc || true')).stdout.trim();
    const view = await liveView(d);
    check((await vnc()) !== '0', 'the stream runs while the view is open');
    const second = await liveView(d).then(
      () => '',
      (e: Error) => e.message,
    );
    check(/already has a VNC stream/.test(second), 'a second view on the same desktop is refused', second);
    await view.stop();
    for (let i = 0; i < 20 && (await vnc()) !== '0'; i++) await new Promise((r) => setTimeout(r, 250));
    check((await vnc()) === '0', 'stop() stopped the stream too');
  }

  console.log('6. A dropped connection stops the Chrome the toolset started');
  {
    const d = await desktop();
    const browser = await E2BBrowserToolset.create({ sandbox: d, urlPolicy: allowHosts(['example.com']) });
    check((await ourChromes(d)) > 0, 'Chrome runs');
    await d.commands.run("sudo ss -K '( sport = :9222 )' >/dev/null", { timeoutMs: 10_000 }); // the connection drops
    for (let i = 0; i < 40 && (await ourChromes(d)) > 0; i++) await new Promise((r) => setTimeout(r, 250));
    check((await ourChromes(d)) === 0, 'Chrome is stopped without waiting for close()');
    await browser.close().catch(() => undefined);
  }

  console.log('7. A startup whose cleanup also fails returns a handle to retry it');
  {
    const connect = CdpClient.connect;
    const kill = BaseSandbox.prototype.kill; // the toolset creates its sandbox with e2b's Sandbox
    let kills = 0;
    CdpClient.connect = async () => {
      throw new Error('injected: connection failed');
    };
    BaseSandbox.prototype.kill = async function (this: BaseSandbox, opts?: Parameters<typeof kill>[0]) {
      if (kills++ === 0) throw new Error('injected: kill failed');
      return kill.call(this, opts);
    } as typeof kill;
    let error: unknown;
    try {
      await E2BBrowserToolset.create({ template: 'desktop', urlPolicy: allowHosts(['example.com']) });
    } catch (e) {
      error = e;
    } finally {
      CdpClient.connect = connect;
    }
    check(error instanceof BrowserInitializationError, 'create() throws BrowserInitializationError', String(error));
    if (error instanceof BrowserInitializationError) {
      const retried = await error.close().then(
        () => 'ok',
        (e: Error) => e.message,
      );
      check(retried === 'ok', 'error.close() finishes the cleanup', retried);
    }
    BaseSandbox.prototype.kill = kill;
  }

  console.log('8. A Chrome that never answers, and cannot be stopped, comes back as a handle to retry');
  {
    const d = await desktop();
    const run = d.commands.run.bind(d.commands);
    d.commands.run = (async (command: string, opts?: never) => {
      if (command.includes('json/version')) return { stdout: '', stderr: '', exitCode: 0 }; // Chrome "never answers"
      if (command.includes('pkill')) throw new Error('injected: stop failed');
      return run(command, opts);
    }) as never;
    const error = await E2BBrowserToolset.create({ sandbox: d, urlPolicy: allowHosts(['example.com']) }).catch(
      (e) => e,
    );
    d.commands.run = run as never;
    check(error instanceof BrowserInitializationError, 'create() throws BrowserInitializationError', String(error));
    check((await ourChromes(d)) > 0, 'the launched Chrome is still running before the retry');
    if (error instanceof BrowserInitializationError) await error.close();
    check((await ourChromes(d)) === 0, 'error.close() stopped it');
  }
} catch (error) {
  failed++;
  console.log(`   ERROR ${(error as Error).stack ?? error}`);
} finally {
  await Promise.all(created.map((s) => Sandbox.kill(s).catch(() => undefined)));
  console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
  process.exitCode = failed ? 1 : 0;
}
