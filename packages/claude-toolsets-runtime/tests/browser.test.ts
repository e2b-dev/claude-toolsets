import { ReferenceStore } from '../src/references.ts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium, type Browser, type CDPSession, type Page } from 'playwright';
import {
  fileInputExpr,
  fileInputValidationFunction,
  ReferenceAllocator,
  runtimeExpression,
  runtimeSource,
  runtimeResult,
} from '../../claude-toolsets-js/src/page-scripts.ts';
import {
  RUNTIME_KEY,
  REF_BLOCK_SIZE,
  type Operation,
  type OperationArgs,
  type OperationValues,
  type RuntimeResult,
} from '../../claude-toolsets-js/src/generated/runtime-contract.ts';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

const fixture = `<!doctype html><html><body>
  <main><h1>Example form</h1>
    <label>Name <input id="name"></label>
    <label>Password <input type="password" value="z9sensitive42"></label>
    <label><input type="checkbox" id="check">Subscribe</label>
    <label>Color <select id="color"><option value="red">Red</option><option value="blue">Blue</option></select></label>
    <label>Files <input type="file" id="file"></label>
    <button id="submit">Submit</button>
    <button disabled>Disabled button</button>
    <div contenteditable="true" aria-label="Editor">Original</div>
    <button style="display:none">Hidden button</button>
    <div id="shadow"></div><iframe id="frame" srcdoc='<button>Frame button</button>'></iframe>
    <p style="margin-top:2000px">Distant text</p>
  </main>
  <script>
    document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>Shadow button</button>';
    window.events=[];
    document.querySelector('#name').addEventListener('input',()=>window.events.push('input'));
    document.querySelector('#name').addEventListener('change',()=>window.events.push('change'));
    document.querySelector('#submit').addEventListener('click',()=>window.clicked=true);
  </script>
</body></html>`;

for (const bridge of ['typescript', 'python'] as const) {
  describe(`${bridge} bridge in a real isolated Chrome context`, () => {
    let page: Page;
    let cdp: CDPSession;
    let contextId: number;
    let nextRef: number;

    async function isolatedWorld() {
      const { frameTree } = await cdp.send('Page.getFrameTree');
      const world = await cdp.send('Page.createIsolatedWorld', {
        frameId: frameTree.frame.id,
        worldName: 'runtime-test',
      });
      contextId = world.executionContextId;
      const source =
        bridge === 'typescript'
          ? runtimeSource
          : Bun.spawnSync([process.env.PYTHON ?? 'python3', 'tests/python-expression.py'], {
              cwd: new URL('../', import.meta.url).pathname,
              stdin: Buffer.from('{"install":true}'),
            }).stdout.toString();
      const installed = await cdp.send('Runtime.evaluate', { expression: source, contextId });
      expect(installed.exceptionDetails).toBeUndefined();
    }
    beforeEach(async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      page = await context.newPage();
      await page.setContent(fixture);
      cdp = await page.context().newCDPSession(page);
      await isolatedWorld();
      nextRef = 1;
    });
    afterEach(async () => {
      await page?.context().close();
    });

    function expression<K extends Operation>(operation: K, args: OperationArgs[K]): string {
      if (bridge === 'typescript') return runtimeExpression(operation, args);
      const result = Bun.spawnSync([process.env.PYTHON ?? 'python3', 'tests/python-expression.py'], {
        cwd: new URL('../', import.meta.url).pathname,
        stdin: Buffer.from(JSON.stringify({ operation, args })),
      });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString();
    }
    async function call<K extends Operation>(
      operation: K,
      args: Omit<OperationArgs[K], 'base'>,
    ): Promise<RuntimeResult<OperationValues[K]>> {
      const result = await cdp.send('Runtime.evaluate', {
        expression: expression(operation, { ...args, base: nextRef } as OperationArgs[K]),
        contextId,
        returnByValue: true,
        awaitPromise: true,
      });
      expect(result.exceptionDetails).toBeUndefined();
      const envelope = runtimeResult<OperationValues[K]>(result.result.value);
      nextRef = Math.max(nextRef, envelope.nextRef);
      return envelope;
    }
    async function value<K extends Operation>(
      operation: K,
      args: Omit<OperationArgs[K], 'base'>,
    ): Promise<OperationValues[K]> {
      const result = await call(operation, args);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    }
    const read = (filter: string | null = 'all', ref: string | null = null) =>
      value('read_page', { filter, ref, depth: 15, cap: 50_000 });
    async function findRef(query: string) {
      const text = await value('find', { query });
      const ref = text.match(/\[(ref_\d+)\]/)?.[1];
      if (!ref) throw new Error(`No ref for ${query}: ${text}`);
      return ref;
    }

    test('reads the composed tree, protects secrets, and honors viewport/depth/cap', async () => {
      const all = await read();
      for (const name of ['Example form', 'Submit', 'Shadow button', 'Frame button', 'Distant text'])
        expect(all).toContain(name);
      expect(all).toContain('value=(hidden)');
      expect(all).not.toContain('z9sensitive42');
      expect(all).not.toContain('Hidden button');
      expect(await read(null)).not.toContain('text "Distant text"');
      expect(await value('find', { query: 'z9sensitive42' })).toBe('');
      expect(await value('read_page', { filter: 'all', ref: null, depth: 1, cap: 50_000 })).toContain('depth limit');
      expect(await value('read_page', { filter: 'all', ref: null, depth: 15, cap: 20 })).toContain('Output truncated');
    });

    test('searches names, roles, attributes, and typos without a model', async () => {
      const submit = await findRef('Submit');
      for (const query of ['submit button', 'Submt', 'please find the submit button']) {
        expect(await findRef(query)).toBe(submit);
      }
      expect(await findRef('name input')).toBe(await findRef('Name'));
      expect(await value('find', { query: 'Shadow button' })).toContain('Shadow button');
      expect(await value('find', { query: 'Frame button' })).toContain('Frame button');
      expect(await value('find', { query: 'zzzznonexistent' })).toBe('');
      expect(await value('find', { query: '   ' })).toBe('');
      expect(await value('find', { query: 'z9sensitive' })).toBe('');
    });

    test('caps search results and excludes secret-marked values from its index', async () => {
      await page.setContent(
        '<input autocomplete="cc-number" value="q8privatecard77">' +
          Array.from({ length: 25 }, (_, index) => `<button>Purchase ${index}</button>`).join(''),
      );
      expect(await value('find', { query: 'q8privatecard77' })).toBe('');
      const results = await value('find', { query: 'Purchase' });
      expect(results.match(/\[ref_\d+\]/g)).toHaveLength(20);
      expect(new Set(results.match(/\[ref_\d+\]/g)).size).toBe(20);
    });

    test('find understands natural-language descriptions', async () => {
      await page.setContent(`<!doctype html><html><body>
        <header><img alt="Acme logo" width="40" height="40" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><a href="#in">Sign in</a></header>
        <form>
          <label for="email">Email</label><input id="email" type="email" autocomplete="email">
          <label for="country">Country</label><select id="country"><option>Slovakia</option><option>Czechia</option></select>
          <input type="search" placeholder="Search products">
          <label><input type="checkbox"> Remember me</label>
          <label for="msg">Message</label><textarea id="msg"></textarea>
          <input type="text" aria-label="Postal code" autocomplete="postal-code">
          <button type="submit">Create account</button>
        </form>
        <p>Create account to get started.</p>
      </body></html>`);
      await isolatedWorld();
      const misses: string[] = [];
      const first = async (query: string) => `${query} -> ${(await value('find', { query })).split('\n')[0] ?? ''}`;
      for (const [query, expected] of [
        ['email field', 'Email'],
        ['email input', 'Email'],
        ['email address box', 'Email'],
        ['country dropdown', 'Country'],
        ['country select', 'Country'],
        ['country picker', 'Country'],
        ['search box', 'Search products'],
        ['search field', 'Search products'],
        ['logo image', 'Acme logo'],
        ['acme logo', 'Acme logo'],
        ['remember me checkbox', 'Remember me'],
        ['message text area', 'Message'],
        ['message box', 'Message'],
        ['sign in link', 'Sign in'],
        ['postal code field', 'Postal code'],
        ['the create account button at the bottom of the form', 'Create account'],
      ] as Array<[string, string]>) {
        const line = await first(query);
        if (!line.includes(expected)) misses.push(line);
      }
      // the interactive element wins over plain text with the same words
      const preferred = await first('create account');
      if (!/-> - button "Create account"/.test(preferred)) misses.push(preferred);
      expect(misses).toEqual([]);
    });

    test('read_page and find share references while reflecting DOM changes', async () => {
      const ref = await findRef('Submit');
      expect(await read()).toContain(`button "Submit" [${ref}]`);
      await page.locator('#submit').evaluate((element) => {
        element.textContent = 'Publish';
      });
      expect(await findRef('Publish')).toBe(ref);
      expect(await read()).toContain(`button "Publish" [${ref}]`);
      expect(await read()).not.toContain('button "Submit"');
      expect(expression('find', { query: 'Publish', base: nextRef }).length).toBeLessThan(250);
    });

    test('reuses installation and refs but refreshes focus state on each call', async () => {
      const ref = await findRef('Submit');
      await cdp.send('Runtime.evaluate', {
        expression: `globalThis.previousRuntime=globalThis[${JSON.stringify(RUNTIME_KEY)}]`,
        contextId,
      });
      expect(await findRef('Submit')).toBe(ref);
      const identity = await cdp.send('Runtime.evaluate', {
        expression: `globalThis.previousRuntime===globalThis[${JSON.stringify(RUNTIME_KEY)}]`,
        contextId,
        returnByValue: true,
      });
      expect(identity.result.value).toBe(true);
      expect(await page.evaluate((key) => Object.hasOwn(window, key), RUNTIME_KEY)).toBe(false);
      await page.locator('#submit').focus();
      expect((await read()).split('\n').find((line) => line.includes(`[${ref}]`))).toContain('focused');
      await page.locator('#name').focus();
      expect((await read()).split('\n').find((line) => line.includes(`[${ref}]`))).not.toContain('focused');
    });

    test('resolves a ref into coordinates for native CDP mouse events', async () => {
      const ref = await findRef('Submit');
      const point = await value('resolve', { ref, action: 'click' });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
      expect(await page.evaluate<boolean>('window.clicked')).toBe(true);
      const disabled = await findRef('Disabled button');
      const result = await call('resolve', { ref: disabled, action: 'click' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('disabled');
    });

    test('reports an overlay and advances the ref counter even on failure', async () => {
      const ref = await findRef('Submit');
      const before = nextRef;
      await page.evaluate(() => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:999;background:white';
        document.body.append(overlay);
      });
      const result = await call('resolve', { ref, action: 'click' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain(`covered by another element (ref_${before})`);
      expect(nextRef).toBe(before + 1);
    });

    test('sets forms, dispatches events, and passes hostile-looking text only as data', async () => {
      const name = await findRef('Name');
      const text = '"}); globalThis.injected = true; //\\\nGrüße';
      await value('form_input', { ref: name, value: text });
      expect(await page.locator('#name').inputValue()).toBe(text.replace(/\n/g, '')); // single-line inputs normalize newlines
      expect(await page.evaluate<string[]>('window.events')).toEqual(['input', 'change']);
      expect(
        (await cdp.send('Runtime.evaluate', { expression: 'globalThis.injected', contextId, returnByValue: true }))
          .result.value,
      ).toBeUndefined();
      await value('form_input', { ref: await findRef('Subscribe'), value: true });
      expect(await page.locator('#check').isChecked()).toBe(true);
      await value('form_input', { ref: await findRef('Color'), value: 'Blue' });
      expect(await page.locator('#color').inputValue()).toBe('blue');
      await value('form_input', { ref: await findRef('Editor'), value: 'Updated' });
      expect(await page.locator('[contenteditable]').innerText()).toBe('Updated');
      const secret = await value('form_input', { ref: await findRef('Password'), value: 'another-secret' });
      expect(secret.summary).toContain('hidden value');
      expect(secret.summary).not.toContain('another-secret');
    });

    test('scrolls to offscreen content and reads bounded page text', async () => {
      const ref = await findRef('Distant text');
      expect(await value('scroll_to', { ref })).toBeNull();
      expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
      const text = await value('page_text', { max: 30 });
      expect(text).toContain('[Truncated:');
      expect(text).not.toContain('z9sensitive42');
    });

    test('refuses removed and previous-document refs without reuse', async () => {
      const ref = await findRef('Submit');
      await page.locator('#submit').evaluate((element) => element.remove());
      const detached = await call('resolve', { ref, action: 'click' });
      expect(detached.ok).toBe(false);
      if (!detached.ok) expect(detached.error.code).toBe('stale_ref');
      const before = nextRef;
      await page.goto('data:text/html,<button>Submit</button>');
      await isolatedWorld();
      expect(await findRef('Submit')).toBe(`ref_${before}`);
      const stale = await call('resolve', { ref, action: 'click' });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.error.code).toBe('stale_ref');
    });

    test("never resolves another tab's reference to a local element", async () => {
      const previous = await findRef('Submit');
      const base = nextRef;
      page = await page.context().newPage();
      await page.setContent('<button>Submit</button>');
      cdp = await page.context().newCDPSession(page);
      await isolatedWorld();
      expect(await findRef('Submit')).toBe(`ref_${base}`);
      const result = await call('resolve', { ref: previous, action: 'click' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('stale_ref');
    });

    test('lost allocation replies cannot alias references in another tab', async () => {
      const allocator = new ReferenceAllocator();
      const lostBase = allocator.reserve();
      // Let Chrome allocate refs, then deliberately discard the result.
      await cdp.send('Runtime.evaluate', {
        expression: expression('find', { query: 'Submit', base: lostBase }),
        contextId,
        returnByValue: true,
        awaitPromise: true,
      });
      const firstCdp = cdp;
      const firstContext = contextId;
      page = await page.context().newPage();
      await page.setContent('<button>Submit</button>');
      cdp = await page.context().newCDPSession(page);
      await isolatedWorld();
      nextRef = allocator.reserve();
      expect(nextRef).toBe(lostBase + REF_BLOCK_SIZE);
      const secondRef = await findRef('Submit');
      const result = await firstCdp.send('Runtime.evaluate', {
        expression: expression('resolve', { ref: secondRef, action: 'click', base: allocator.reserve() }),
        contextId: firstContext,
        returnByValue: true,
        awaitPromise: true,
      });
      expect(result.result.value.ok).toBe(false);
      expect(result.result.value.error.code).toBe('stale_ref');
    });

    test('sanitizes unexpected exceptions', async () => {
      await cdp.send('Runtime.evaluate', {
        expression: `Document.prototype.querySelectorAll = () => { throw new Error('private-endpoint-token'); }`,
        contextId,
      });
      const result = await call('page_text', { max: 100 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toEqual({ code: 'script_failed', message: 'The page script failed' });
    });

    if (bridge === 'typescript') {
      for (const kind of ['shadow', 'slot'] as const)
        for (const attribute of ['inert', 'aria-disabled'] as const)
          test(`rejects ${kind} file inputs when an ancestor becomes ${attribute}`, async () => {
            await page.evaluate((kind) => {
              const host = document.querySelector('#shadow')!;
              host.shadowRoot!.innerHTML =
                kind === 'shadow' ? '<label>Upload<input type="file"></label>' : '<section><slot></slot></section>';
              if (kind === 'slot') host.innerHTML = '<label>Upload<input type="file"></label>';
            }, kind);
            const ref = await findRef('Upload');
            const target = await cdp.send('Runtime.evaluate', {
              expression: fileInputExpr(ref, 1, nextRef),
              contextId,
              returnByValue: false,
              awaitPromise: true,
            });
            expect(target.result.subtype).toBe('node');
            const objectId = target.result.objectId!;
            const recheck = () =>
              cdp.send('Runtime.callFunctionOn', {
                objectId,
                functionDeclaration: fileInputValidationFunction(ref, 1, nextRef),
                returnByValue: true,
                awaitPromise: true,
              });
            expect((await recheck()).result.value).toBe(true);
            await page.evaluate(
              ({ kind, attribute }) => {
                const host = document.querySelector('#shadow')!;
                const ancestor = kind === 'slot' ? host.shadowRoot!.querySelector('section')! : host;
                ancestor.setAttribute(attribute, 'true');
              },
              { kind, attribute },
            );
            expect((await recheck()).result.value).toBe(false);
            const invalid = await cdp.send('Runtime.evaluate', {
              expression: fileInputExpr(ref, 1, nextRef),
              contextId,
              returnByValue: true,
              awaitPromise: true,
            });
            expect(invalid.result.value.error).toContain('disabled or inert');
            await cdp.send('Runtime.releaseObject', { objectId });
          });
    }

    if (bridge === 'typescript')
      test('returns a pinned file input node through CDP', async () => {
        const ref = await findRef('Files');
        const result = await cdp.send('Runtime.evaluate', {
          expression: fileInputExpr(ref, 1, nextRef),
          contextId,
          returnByValue: false,
          awaitPromise: true,
        });
        expect(result.exceptionDetails).toBeUndefined();
        expect(result.result.subtype).toBe('node');
        const objectId = result.result.objectId!;
        const node = await cdp.send('DOM.describeNode', { objectId });
        expect(node.node.nodeName).toBe('INPUT');
        await cdp.send('Runtime.releaseObject', { objectId });
        const invalid = await cdp.send('Runtime.evaluate', {
          expression: fileInputExpr(ref, 2, nextRef),
          contextId,
          returnByValue: false,
          awaitPromise: true,
        });
        expect(invalid.result.subtype).not.toBe('node');
        const details = await cdp.send('Runtime.callFunctionOn', {
          objectId: invalid.result.objectId!,
          functionDeclaration: 'function(){return this.error}',
          returnByValue: true,
        });
        expect(details.result.value).toContain('multiple files');
        await cdp.send('Runtime.releaseObject', { objectId: invalid.result.objectId! });
      });
  });
}

test('both packages embed the exact bundle and checksum', () => {
  const ts = readFileSync(new URL('../../claude-toolsets-js/src/generated/runtime.js', import.meta.url));
  const py = readFileSync(
    new URL('../../claude-toolsets-python/e2b_claude_toolsets/_runtime/runtime.js', import.meta.url),
  );
  expect(ts.equals(py)).toBe(true);
  const manifest = JSON.parse(
    readFileSync(new URL('../../claude-toolsets-js/src/generated/manifest.json', import.meta.url), 'utf8'),
  );
  expect(createHash('sha256').update(ts).digest('hex')).toBe(manifest.sha256);
});

test('reference allocation cannot spill into the next reserved block', () => {
  const refs = new ReferenceStore();
  refs.advance(1);
  refs.next = REF_BLOCK_SIZE;
  expect(refs.refOf({} as Element)).toBe(`ref_${REF_BLOCK_SIZE}`);
  expect(() => refs.refOf({} as Element)).toThrow('Reference allocation limit reached');
  refs.advance(REF_BLOCK_SIZE + 1);
  expect(refs.refOf({} as Element)).toBe(`ref_${REF_BLOCK_SIZE + 1}`);
  expect(() => refs.advance(Number.MAX_SAFE_INTEGER)).toThrow('Invalid reference base');
});

test('a late older request cannot shrink the current allocation block', () => {
  const refs = new ReferenceStore();
  refs.advance(1 + 2 * REF_BLOCK_SIZE);
  const first = refs.refOf({} as Element);
  refs.advance(1);
  const second = refs.refOf({} as Element);
  expect(first).toBe(`ref_${1 + 2 * REF_BLOCK_SIZE}`);
  expect(second).toBe(`ref_${2 + 2 * REF_BLOCK_SIZE}`);
});
