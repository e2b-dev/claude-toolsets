#!/usr/bin/env bun
/**
 * Live checks for `E2BBrowserToolset.detach()`: no model, an E2B key only.
 *
 *     TEMPLATE=<snapshot-capable desktop template> pnpm -F @e2b/claude-toolsets exercise:detach
 *
 * Fork and pause need a template whose envd supports snapshots (0.5.0 or newer); the public `desktop` template does
 * not yet. Without `detach()`, a snapshot taken while the toolset is connected leaves Chrome holding every page request
 * for a client that is gone, and each navigation times out after 30 s. These checks show that after `detach()`:
 *   - the base sandbox and each fork navigate with a new toolset;
 *   - a paused and resumed sandbox navigates with a new toolset, and its tab is still there;
 *   - the detached instance refuses calls, and detach is refused where it would orphan something.
 * Every sandbox it creates is killed at the end; the script exits non-zero if a check failed.
 */
import { performance } from 'node:perf_hooks';
import { Sandbox } from '@e2b/desktop';
import { E2BBrowserToolset, allowHosts } from '../src/index.ts';

const template = process.env.TEMPLATE;
if (!template) throw new Error('Set TEMPLATE to a desktop template that supports snapshots (envd 0.5.0 or newer)');
const urlPolicy = allowHosts(['example.com']);
const network = { allowPublicTraffic: false, maskRequestHost: 'localhost:${PORT}' };
const created: string[] = [];
let failed = 0;
let id = 0;

const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failed++;
  console.log(`   ${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` · ${detail}` : ''}`);
};
async function navigate(browser: E2BBrowserToolset, url: string) {
  const t = performance.now();
  const use = { type: 'tool_use', id: `d_${++id}`, toolset_name: 'browser', name: 'navigate', input: { url } };
  // a closed toolset throws ToolsetClosedError rather than answering with an error result
  const r = await browser
    .toolResult(use as never)
    .catch((e: Error) => ({ is_error: true, content: `${e.name}: ${e.message}` }));
  const text = (typeof r.content === 'string' ? r.content : JSON.stringify(r.content)).replace(/\s+/g, ' ');
  return { ok: !r.is_error, text: text.slice(0, 100), s: ((performance.now() - t) / 1000).toFixed(1) };
}
async function desktop() {
  const d = await Sandbox.create(template!, { resolution: [1280, 800], timeoutMs: 600_000, network });
  created.push(d.sandboxId);
  return d;
}
/** Fork, retrying E2B's "node is busy, please retry" a few times. */
async function fork(sandboxId: string, count: number) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await Sandbox.fork(sandboxId, { count });
    } catch (error) {
      if (attempt >= 4 || !/busy|retry/i.test(String(error))) throw error;
      await new Promise((r) => setTimeout(r, attempt * 3_000));
    }
  }
}
const attach = (sandbox: Sandbox) => E2BBrowserToolset.create({ sandbox, display: ':0', urlPolicy });

try {
  console.log('Fork after detach');
  {
    const base = await desktop();
    const browser = await attach(base);
    check((await navigate(browser, 'https://example.com/?base')).ok, 'base navigates before detach');
    await browser.detach();
    const after = await navigate(browser, 'https://example.com/?late');
    check(!after.ok, 'detached instance refuses calls', after.text);
    await browser.close(); // a no-op after detach, and must not stop Chrome
    const forks = (await fork(base.sandboxId, 2)).filter((f): f is Sandbox => f instanceof Sandbox);
    created.push(...forks.map((f) => f.sandboxId));
    check(forks.length === 2, 'fork returned 2 sandboxes');
    for (const [name, sandbox] of [['base', base], ...forks.map((f, i) => [`fork ${i + 1}`, f] as const)] as const) {
      const next = await attach(sandbox);
      const r = await navigate(next, `https://example.com/?${name.replace(' ', '')}`);
      check(r.ok, `${name}: new toolset navigates`, `${r.s} s · ${r.text}`);
      await next.close();
    }
  }

  console.log('Pause and resume after detach');
  {
    const d = await desktop();
    const browser = await attach(d);
    await navigate(browser, 'https://example.com/?before-pause');
    await browser.detach();
    await d.pause();
    const resumed = await Sandbox.connect(d.sandboxId);
    const next = await attach(resumed);
    const tabs = await next.toolResult({
      type: 'tool_use',
      id: `d_${++id}`,
      toolset_name: 'browser',
      name: 'list_tabs',
      input: {},
    } as never);
    check(JSON.stringify(tabs.content).includes('before-pause'), 'the tab from before the pause is still open');
    const r = await navigate(next, 'https://example.com/?after-pause');
    check(r.ok, 'resumed sandbox: new toolset navigates', `${r.s} s · ${r.text}`);
    await next.close();
  }

  console.log('Refs stay unique after detach and re-attach');
  {
    const d = await desktop();
    const call = async (b: E2BBrowserToolset, name: string, input: Record<string, unknown> = {}) => {
      const r = await b.toolResult({
        type: 'tool_use',
        id: `d_${++id}`,
        toolset_name: 'browser',
        name,
        input,
      } as never);
      return typeof r.content === 'string' ? r.content : JSON.stringify(r.content);
    };
    const refs = (text: string) => new Set(text.match(/ref_\d+/g) ?? []);
    const first = await attach(d);
    await call(first, 'navigate', { url: 'https://example.com/?one' });
    await call(first, 'read_page', { filter: 'all' }); // tab 1's elements get refs from the first toolset
    await first.detach();
    const second = await attach(d);
    const tab1 = refs(await call(second, 'read_page', { filter: 'all' })); // same document, not navigated
    await call(second, 'new_tab');
    await call(second, 'navigate', { url: 'https://example.com/?two' });
    const tab2 = refs(await call(second, 'read_page', { filter: 'all' }));
    const shared = [...tab1].filter((r) => tab2.has(r));
    check(tab1.size > 0 && tab2.size > 0, 'both tabs list refs', `${tab1.size} and ${tab2.size}`);
    check(shared.length === 0, 'no ref names an element in both tabs', shared.join(', ') || 'none shared');
    await second.close();
  }

  console.log('A failed detach leaves close() working');
  {
    const d = await desktop();
    const browser = await attach(d);
    await d.commands.run("sudo ss -K '( sport = :9222 )' >/dev/null", { timeoutMs: 10_000 }); // cut the connection
    await new Promise((r) => setTimeout(r, 500));
    const failed = await browser.detach().then(
      () => '',
      (e: Error) => e.message,
    );
    check(/close\(\) to clean up/.test(failed), 'detach reports the lost connection', failed);
    const closed = await browser.close().then(
      () => 'ok',
      (e: Error) => e.message,
    );
    check(closed === 'ok' || !closed.startsWith('detach'), 'close() runs its own cleanup afterwards', closed);
  }

  console.log('Refusals');
  {
    const owned = await E2BBrowserToolset.create({ template, urlPolicy });
    created.push(owned.sandbox.sandboxId);
    const refused = await owned.detach().then(
      () => '',
      (e: Error) => e.message,
    );
    check(/use close\(\)/.test(refused), 'detach refused on a sandbox the toolset created', refused);
    check((await navigate(owned, 'https://example.com/?still')).ok, 'that toolset still works after the refusal');
    await owned.close();

    const d = await desktop();
    const browser = await attach(d);
    await browser.close();
    const again = await browser.detach().then(
      () => '',
      (e: Error) => e.message,
    );
    check(/already closed/.test(again), 'detach refused after close', again);
  }
} catch (error) {
  failed++;
  console.log(`   ERROR ${(error as Error).stack ?? error}`);
} finally {
  await Promise.all(created.map((s) => Sandbox.kill(s).catch(() => undefined)));
  console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
  process.exitCode = failed ? 1 : 0;
}
