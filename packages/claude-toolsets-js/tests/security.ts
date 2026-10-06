#!/usr/bin/env bun
/**
 * Live security checks, with failures injected: no model, an E2B key only.
 *
 *     pnpm -F @e2b/claude-toolsets exercise:security
 *
 *   1. back/forward/reload are checked against the URL policy, also when no request is made (same-document history),
 *      here after a detach and a re-attach with a stricter policy.
 *   2. Desktop failures reach the model as fixed text, never the provider's error (which can carry hosts or tokens).
 *   3. Upload staging failures likewise.
 * Every sandbox it creates is killed at the end; the script exits non-zero if a check failed.
 */
import { Sandbox } from '@e2b/desktop';
import { BetaNodeFilePolicy } from '@anthropic-ai/sdk/helpers/beta/toolsets/node';
import { ToolError } from '@anthropic-ai/sdk/helpers/beta/toolsets';
import { E2BBrowserToolset, E2BComputerToolset, allowHosts } from '../src/index.ts';

const SECRET = 'e2b_SECRET_TOKEN_sentinel';
let failed = 0;
let id = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failed++;
  console.log(`   ${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` · ${detail}` : ''}`);
};
type Toolset = E2BBrowserToolset | E2BComputerToolset;
async function call(t: Toolset, name: string, input: Record<string, unknown> = {}) {
  const r = await t.toolResult({
    type: 'tool_use',
    id: `s_${++id}`,
    toolset_name: t.toolsetName,
    name,
    input,
  } as never);
  const text = typeof r.content === 'string' ? r.content : JSON.stringify(r.content);
  return { error: !!r.is_error, text };
}

const desktop = await Sandbox.create({
  resolution: [1280, 800],
  timeoutMs: 600_000,
  network: { allowPublicTraffic: false, maskRequestHost: 'localhost:${PORT}' },
});
try {
  console.log('1. History is checked against the URL policy');
  {
    const first = await E2BBrowserToolset.create({ sandbox: desktop, urlPolicy: allowHosts(['example.com']) });
    await call(first, 'navigate', { url: 'https://example.com/#secret' });
    await call(first, 'navigate', { url: 'https://example.com/#ok' }); // same document: no request to intercept
    await first.detach();
    // a stricter policy: the #secret page is no longer allowed
    const strict = allowHosts(['example.com']);
    const second = await E2BBrowserToolset.create({
      sandbox: desktop,
      urlPolicy: (ctx, url) => {
        if (String(url).includes('#secret')) throw new ToolError('blocked: #secret');
        return strict(ctx, url);
      },
    });
    const back = await call(second, 'navigate', { url: 'back' });
    check(back.error && /not allowed/.test(back.text), 'back to a refused page is refused', back.text.slice(0, 100));
    const tabs = await call(second, 'list_tabs');
    check(tabs.text.includes('#ok') && !tabs.text.includes('#secret'), 'the tab stayed where it was');
    const reload = await call(second, 'navigate', { url: 'reload' });
    check(!reload.error, 'reload of an allowed page still works', reload.text.slice(0, 80));
    await second.close();
  }

  console.log('2. Desktop failures reach the model as fixed text');
  {
    const computer = await E2BComputerToolset.create(desktop, { confirm: () => true });
    const run = desktop.commands.run.bind(desktop.commands);
    const screenshot = desktop.screenshot.bind(desktop);
    const leak = () => Promise.reject(new Error(`sandbox ${desktop.sandboxId} host 49983-x.e2b.app token=${SECRET}`));
    desktop.commands.run = leak as never;
    desktop.screenshot = leak as never;
    try {
      const click = await call(computer, 'left_click', { coordinate: [100, 100] });
      check(
        click.error && !click.text.includes(SECRET),
        'a failed click hides the provider error',
        click.text.slice(0, 90),
      );
      const shot = await call(computer, 'screenshot');
      check(
        shot.error && !shot.text.includes(SECRET),
        'a failed screenshot hides the provider error',
        shot.text.slice(0, 90),
      );
    } finally {
      desktop.commands.run = run as never;
      desktop.screenshot = screenshot as never;
    }
    const bad = await call(computer, 'left_click', { coordinate: [5000, 0] });
    check(bad.error && /outside/.test(bad.text), 'our own refusals still pass through', bad.text.slice(0, 80));
    await computer.close();
  }

  console.log('3. Upload staging failures reach the model as fixed text');
  {
    const browser = await E2BBrowserToolset.create({
      sandbox: desktop,
      urlPolicy: allowHosts(['example.com']),
      configs: { file_upload: { enabled: true }, javascript_exec: { enabled: true } },
      filePolicy: new BetaNodeFilePolicy({ uploadRoots: [], uploadDocumentIds: ['note'] }),
      uploadDocuments: new Map([['note', { name: 'note.txt', data: new TextEncoder().encode('hello') }]]),
      confirm: () => true, // throwaway sandbox: approve the upload and the script that adds a file input
    });
    await call(browser, 'navigate', { url: 'https://example.com' });
    await call(browser, 'javascript_exec', {
      text: "const i = document.createElement('input'); i.type = 'file'; i.setAttribute('aria-label', 'Attachment'); document.body.append(i); 'ok'",
    });
    const ref = (await call(browser, 'find', { query: 'attachment' })).text.match(/ref_\d+/)?.[0];
    const files = browser.sandbox.files;
    const write = files.write.bind(files);
    files.write = (() =>
      Promise.reject(new Error(`write failed on ${browser.sandbox.sandboxId} token=${SECRET}`))) as never;
    try {
      const up = await call(browser, 'file_upload', { target: { type: 'ref', ref }, document_ids: ['note'] });
      check(
        !!ref && up.error && !up.text.includes(SECRET),
        'a failed upload hides the provider error',
        up.text.slice(0, 100),
      );
    } finally {
      files.write = write as never;
    }
    await browser.close();
  }
} catch (error) {
  failed++;
  console.log(`   ERROR ${(error as Error).stack ?? error}`);
} finally {
  await desktop.kill().catch(() => undefined);
  console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
  process.exitCode = failed ? 1 : 0;
}
