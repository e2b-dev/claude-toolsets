#!/usr/bin/env bun
/**
 * Exercise the E2B browser toolset with the calls a model would make, against pages served inside the sandbox: no
 * Anthropic API key, no model.
 *
 * Usage:
 *
 *     pnpm -F @e2b/claude-toolsets exercise   # stock @e2b/desktop
 *
 * The script starts the driver (an E2B sandbox with headless Chrome), writes a few fixture pages into the sandbox
 * under /tmp/fixtures and serves them there with `python3 -m http.server` on 127.0.0.1:8000. The URL policy admits
 * `localhost:8000`, `example.com` and `iana.org`; the sandbox egress admits only `example.com`, so the browser can
 * reach nothing else even if the policy were wrong (`iana.org` is there to show how that failure reads). It then sends the `tool_use` calls a model would send through
 * `browser.toolResult()`, which runs the same pipeline as the tool runner, prints each `tool_result` as the model
 * would see it (image data elided to its size), and checks it. It covers every member the driver implements, plus
 * popups, dialogs, refused navigations and schemes, refused clicks, forms, keys, scrolling, console and network
 * buffers, canvas drawing, history and downloads.
 *
 * `javascript_exec` is enabled here, with a `confirm` that approves every call: the checks read page state with it
 * (scroll offsets, canvas pixels, the selection), and the browser runs in a throwaway sandbox that holds nothing but
 * these fixtures. Never approve blindly for a browser that can reach anything you care about.
 *
 * Every check runs even after one fails; the script exits non-zero if any failed. The sandbox is killed at the end.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BetaNodeFilePolicy } from '@anthropic-ai/sdk/helpers/beta/toolsets/node';
import { DesktopSDK } from './support/desktop.ts';
import type { Sandbox } from 'e2b';

import type {
  BetaBrowserStateBlockParam,
  BetaToolResultBlockParam,
  BetaToolResultContentBlockParam,
} from '@anthropic-ai/sdk/resources/beta';

import { E2BBrowserToolset } from '../src/e2b-browser.ts';
import { examplePolicy } from '../src/policy.ts';

const ORIGIN = 'http://localhost:8000';
const FIXTURES = '/tmp/fixtures';

const INDEX = `<!doctype html>
<title>Exercise page</title>
<style>
  body { margin: 0; padding: 8px; font: 16px sans-serif; }
  #pad { border: 1px solid #000; display: block; touch-action: none; }
  .cover { position: relative; display: inline-block; }
  .cover span { position: absolute; display: block; inset: -4px; background: rgba(0, 0, 0, 0.3); }
  #tall { height: 2400px; }
</style>
<h1>Exercise page</h1>
<p id="status">The button has not been clicked.</p>
<p id="events">events:</p>
<p id="keys">keys:</p>
<canvas id="pad" width="300" height="120" aria-label="Drawing pad"></canvas>
<p>
  <button id="b" onclick="count()" oncontextmenu="log('contextmenu'); return false" onauxclick="log('auxclick ' + event.button)" ondblclick="log('dblclick')">Click me</button>
  <button disabled onclick="log('disabled clicked')">Disabled button</button>
  <span class="cover"><button onclick="log('covered clicked')">Covered button</button><span></span></span>
  <button onclick="alert('Hello from alert')">Alert me</button>
  <button onclick="log('confirm returned ' + confirm('Delete everything?'))">Confirm me</button>
  <button onclick="window.open('/popup.html')">Open popup</button>
  <button onclick="setTimeout(() => window.open('/popup.html'), 1500)">Delayed popup</button>
  <button onclick="location.href = 'http://127.0.0.1:8000/'">Leave for another host</button>
  <button onclick="fetch('/data.json').then((r) => r.json()).then((d) => { console.log('fetched', d.answer); log('fetched ' + d.answer); })">Fetch data</button>
</p>
<p>
  <a href="/popup.html" target="_blank">Blank link</a>
  <a href="/page2.html">Next page</a>
  <a href="/file.txt" download="file.txt">Download file</a>
</p>
<p id="triple">Triple click selects this whole paragraph of words.</p>
<form onsubmit="return false">
  <label>Name <input id="name" oninput="echo()"></label>
  <label><input type="checkbox" id="agree" onchange="echo()"> Agree to terms</label>
  <label>Size <select id="size" onchange="echo()"><option value="s">Small</option><option value="l">Large</option><option value="x" disabled>Huge</option></select></label>
  <label>Upload single <input id="singleFile" type="file"></label>
  <label>Upload multiple <input id="multipleFiles" type="file" multiple></label>
  <label>Upload disabled <input id="disabledFile" type="file" disabled></label>
</form>
<p id="echo">Name: (empty); Agree: no; Size: Small</p>
<div id="hover" tabindex="0" onmouseover="log('hovered')" style="width: 200px; height: 40px; background: #ccc">Hover zone</div>
<div id="tall"></div>
<p>Bottom of the page</p>
<script>
  let clicks = 0;
  function log(text) { document.getElementById('events').textContent += ' ' + text + ';'; }
  function count() { clicks++; document.getElementById('status').textContent = 'The button was clicked ' + clicks + ' times.'; }
  function echo() {
    const size = document.getElementById('size');
    document.getElementById('echo').textContent = 'Name: ' + (document.getElementById('name').value || '(empty)') +
      '; Agree: ' + (document.getElementById('agree').checked ? 'yes' : 'no') + '; Size: ' + size.options[size.selectedIndex].text;
  }
  for (const type of ['keydown', 'keyup'])
    document.addEventListener(type, (e) => { if (e.key === 'Shift') document.getElementById('keys').textContent += ' ' + type + ' Shift;'; });
  const pad = document.getElementById('pad'), ink = pad.getContext('2d');
  pad.addEventListener('pointerdown', (e) => { ink.beginPath(); ink.moveTo(e.offsetX, e.offsetY); });
  pad.addEventListener('pointermove', (e) => { if (e.buttons & 1) { ink.lineTo(e.offsetX, e.offsetY); ink.lineWidth = 4; ink.stroke(); } });
  console.log('page loaded', 42);
</script>
`;

const POPUP = `<!doctype html><title>Popup page</title><h1>Popup page</h1><p>This page opened in a new tab.</p>`;
const PAGE2 = `<!doctype html><title>Second page</title><h1>Second page</h1><p>You reached page two.</p><a href="/">Home</a>`;
/** Redirects itself with script while it loads. */
const JS_REDIRECT = `<!doctype html><title>Redirecting</title><script>location.href = '/page2.html';</script>`;
/** Loads an image from a local address the URL policy does not admit. */
const LOCAL_IMG = `<!doctype html><title>Local image</title><img src="http://127.0.0.1:8000/file.txt" alt="local">`;

/** Every member the driver implements; each must be called at least once below. */
const MEMBERS = [
  'navigate',
  'screenshot',
  'zoom',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'hover',
  'left_click_drag',
  'left_mouse_down',
  'left_mouse_up',
  'mouse_move',
  'scroll',
  'scroll_to',
  'type',
  'key',
  'hold_key',
  'form_input',
  'read_page',
  'find',
  'get_page_text',
  'wait',
  'javascript_exec',
  'read_console',
  'read_network',
  'new_tab',
  'list_tabs',
  'switch_tab',
  'close_tab',
  'file_upload',
] as const;

const t0 = Date.now();
const called = new Set<string>();
const timings: Array<{ name: string; ms: number }> = [];
let failures = 0;
let nextId = 1;

function check(ok: boolean, what: string): void {
  if (!ok) failures++;
  console.log(`   ${ok ? 'PASS' : 'FAIL'} ${what}`);
}

/** The result's content blocks. `content` is a string or a list of blocks; a string becomes one text block. */
function blocksOf(result: BetaToolResultBlockParam): BetaToolResultContentBlockParam[] {
  const content = result.content ?? '';
  return typeof content === 'string' ? [{ type: 'text', text: content }] : [...content];
}

function textOf(result: BetaToolResultBlockParam): string {
  return blocksOf(result)
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
}

function stateOf(result: BetaToolResultBlockParam): BetaBrowserStateBlockParam | undefined {
  return blocksOf(result).find((block): block is BetaBrowserStateBlockParam => block.type === 'browser_state');
}

function activeTab(result: BetaToolResultBlockParam): string | undefined {
  return stateOf(result)?.tabs.find((tab) => tab.active === true)?.tab_id;
}

function changeTypes(result: BetaToolResultBlockParam): string[] {
  return (stateOf(result)?.state_changes ?? []).map((change) => change.type);
}

function hasImage(result: BetaToolResultBlockParam): boolean {
  return blocksOf(result).some((block) => block.type === 'image' && block.source.type === 'base64');
}

/** A block as printed: image data replaced by its length, long text cut. */
function shown(block: BetaToolResultContentBlockParam): unknown {
  if (block.type === 'image' && block.source.type === 'base64')
    return { type: 'image', media_type: block.source.media_type, base64_bytes: block.source.data.length };
  if (block.type === 'text' && block.text.length > 1500)
    return { type: 'text', text: `${block.text.slice(0, 1500)} [... ${block.text.length - 1500} more characters]` };
  return block;
}

/** The first `ref_N` on the line of `text` that matches `pattern`. */
function refOn(text: string, pattern: RegExp): string | undefined {
  const line = text.split('\n').find((candidate) => pattern.test(candidate));
  return line === undefined ? undefined : /\[(ref_\d+)\]/.exec(line)?.[1];
}

const ref = (id: string | undefined): { type: 'ref'; ref: string } => ({ type: 'ref', ref: id ?? 'ref_0' });
const at = (x: number, y: number): { type: 'coordinate'; x: number; y: number } => ({ type: 'coordinate', x, y });

/** A desktop to exercise: a sandbox with a running X display (Chrome goes headful on :0) and a way to kill it. */
export interface ExerciseDesktop {
  sandbox: Sandbox;
  kill(): Promise<void>;
}
export type CreateExerciseDesktop = (opts: {
  network: { allowOut: string[]; denyOut: string[] };
  metadata: Record<string, string>;
}) => Promise<ExerciseDesktop>;

/** Run every check against the desktop `createDesktop` returns. */
export async function exercise(createDesktop: CreateExerciseDesktop): Promise<void> {
  const uploadRoot = mkdtempSync(join(tmpdir(), 'e2b-upload-test-'));
  const localFile = join(uploadRoot, 'approved.txt');
  writeFileSync(localFile, 'local upload content\n');
  const network = { allowOut: ['example.com'], denyOut: ['0.0.0.0/0'] };
  const desktop = await createDesktop({ network, metadata: { purpose: 'toolset-exercise' } });
  let approveUpload = true;
  let uploadConfirms = 0;
  console.log('Starting the sandbox and Chrome...');
  const browser = await E2BBrowserToolset.create({
    sandbox: desktop.sandbox,
    display: ':0',
    urlPolicy: examplePolicy(['localhost:8000', 'example.com', 'iana.org']),
    configs: {
      javascript_exec: { enabled: true },
      read_console: { enabled: true },
      read_network: { enabled: true },
      file_upload: { enabled: true },
    },
    filePolicy: new BetaNodeFilePolicy({
      uploadRoots: [uploadRoot],
      uploadDocumentIds: ['document-one', 'document-two', 'not-staged'],
    }),
    uploadDocuments: new Map([
      ['document-one', { name: 'note.txt', data: new TextEncoder().encode('document upload content') }],
      ['document-two', { name: 'note.txt', data: new Uint8Array([0, 1, 255, 128]) }],
    ]),
    confirm: (ctx) => {
      if (ctx.member === 'file_upload') {
        uploadConfirms++;
        return approveUpload;
      }
      return true;
    },
  }).catch(async (error) => {
    await desktop.kill();
    rmSync(uploadRoot, { recursive: true, force: true });
    throw error;
  });
  const startMs = Date.now() - t0;
  console.log(`Sandbox and Chrome ready in ${(startMs / 1000).toFixed(1)} s`);

  /** Send one tool call as the model would, and print the result as the model would see it. */
  async function call(name: string, input: Record<string, unknown> = {}): Promise<BetaToolResultBlockParam> {
    const started = Date.now();
    const result = await browser.toolResult({
      type: 'tool_use',
      id: `toolu_${String(nextId++).padStart(3, '0')}`,
      name,
      input,
      toolset_name: 'browser',
    });
    const ms = Date.now() - started;
    called.add(name);
    timings.push({ name, ms });
    console.log(`\n${name} ${JSON.stringify(input)} -> ${result.is_error ? 'refused' : 'answered'} (${ms} ms)`);
    for (const block of blocksOf(result)) console.log('  ' + JSON.stringify(shown(block)));
    return result;
  }

  /** Evaluate `code` in the page and return its text result (javascript_exec prints values as JSON). */
  async function evaluate(code: string): Promise<string> {
    return textOf(await call('javascript_exec', { text: code })).trim();
  }

  /** The centre of the element `selector`, in viewport coordinates, as the model would read it off a screenshot. */
  async function centreOf(selector: string): Promise<{ x: number; y: number }> {
    const text = await evaluate(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); ` +
        `return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`,
    );
    const [x = -1, y = -1] = JSON.parse(text) as number[];
    return { x, y };
  }

  async function inkedPixels(): Promise<number> {
    const text = await evaluate(
      `(() => { const d = document.getElementById('pad').getContext('2d').getImageData(0, 0, 300, 120).data; ` +
        `let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; })()`,
    );
    return Number(text);
  }

  try {
    // --- fixtures, served inside the sandbox --------------------------------------------------------------------
    const sandbox = browser.sandbox;
    await sandbox.files.write([
      { path: `${FIXTURES}/index.html`, data: INDEX },
      { path: `${FIXTURES}/popup.html`, data: POPUP },
      { path: `${FIXTURES}/page2.html`, data: PAGE2 },
      { path: `${FIXTURES}/jsredirect.html`, data: JS_REDIRECT },
      { path: `${FIXTURES}/local.html`, data: LOCAL_IMG },
      { path: `${FIXTURES}/data.json`, data: '{"answer": 42}' },
      { path: `${FIXTURES}/file.txt`, data: 'hello download\n' },
    ]);
    const server = await sandbox.commands.run(`python3 -m http.server 8000 --bind 127.0.0.1 --directory ${FIXTURES}`, {
      background: true,
      timeoutMs: 0, // the default would stop the server after 60 s
    });
    await server.disconnect();
    for (let i = 0; i < 20; i++) {
      const probe = await sandbox.commands
        .run(`curl -s -o /dev/null -w '%{http_code}' ${ORIGIN}/`)
        .catch(() => undefined);
      if (probe?.stdout === '200') break;
      await sleep(250);
    }

    // --- tabs and navigation -----------------------------------------------------------------------------------
    let r = await call('list_tabs');
    check(stateOf(r)?.tabs.length === 1 && activeTab(r) === 'tab_1', 'one active tab at start');

    r = await call('navigate', { url: `${ORIGIN}/` });
    check(
      !r.is_error && /Exercise page/.test(textOf(r)) && /HTTP 200/.test(textOf(r)),
      'navigate reports title and HTTP 200',
    );
    r = await call('navigate', { url: `${ORIGIN}/missing` });
    check(!r.is_error && /HTTP 404/.test(textOf(r)), 'navigate reports HTTP 404');
    r = await call('navigate', { url: 'back' });
    check(!r.is_error && /Exercise page/.test(textOf(r)), 'navigate back');
    r = await call('navigate', { url: 'forward' });
    check(!r.is_error && /missing/.test(textOf(r)), 'navigate forward');
    r = await call('navigate', { url: `${ORIGIN}/` });

    // --- reading ---------------------------------------------------------------------------------------------------
    r = await call('read_page', { filter: 'all' });
    const tree = textOf(r);
    const button = refOn(tree, /button "Click me"/);
    const disabled = refOn(tree, /button "Disabled button"/);
    const covered = refOn(tree, /button "Covered button"/);
    const nameRef = refOn(tree, /textbox "Name"/);
    const agreeRef = refOn(tree, /checkbox "Agree to terms"/);
    const sizeRef = refOn(tree, /combobox "Size"/);
    check(
      [button, disabled, covered, nameRef, agreeRef, sizeRef].every(Boolean),
      'read_page lists buttons and form fields with refs',
    );
    r = await call('read_page', { filter: 'interactive' });
    check(
      /button "Click me"/.test(textOf(r)) && !/text "Triple click/.test(textOf(r)),
      'read_page interactive lists controls, no text',
    );
    r = await call('find', { query: 'fetch data button' });
    const fetchRef = refOn(textOf(r), /Fetch data/);
    check(fetchRef !== undefined, 'find returns the Fetch data button');
    r = await call('get_page_text');
    check(/The button has not been clicked/.test(textOf(r)), 'get_page_text reads the page');
    r = await call('screenshot');
    check(!r.is_error && hasImage(r), 'screenshot returns an image');
    r = await call('zoom', { region: [0, 0, 640, 400] });
    check(!r.is_error && hasImage(r), 'zoom returns an image');

    // --- clicks ------------------------------------------------------------------------------------------------------
    r = await call('left_click', { target: ref(button) });
    check(!r.is_error, 'left_click on a ref');
    r = await call('double_click', { target: ref(button) });
    r = await call('right_click', { target: ref(button) });
    r = await call('middle_click', { target: ref(button) });
    r = await call('get_page_text');
    check(/clicked 3 times/.test(textOf(r)), 'left_click + double_click count 3 clicks');
    check(/dblclick;/.test(textOf(r)), 'double_click fires dblclick');
    check(/contextmenu;/.test(textOf(r)), 'right_click fires contextmenu');
    check(/auxclick 1;/.test(textOf(r)), 'middle_click fires auxclick with button 1');

    const triple = await centreOf('#triple');
    r = await call('triple_click', { target: at(triple.x, triple.y) });
    check(
      /whole paragraph of words/.test(await evaluate('getSelection().toString()')),
      'triple_click selects the paragraph',
    );

    r = await call('left_click', { target: ref(disabled) });
    check(r.is_error === true && /disabled/i.test(textOf(r)), 'click on a disabled ref refused with a reason');
    r = await call('left_click', { target: ref(covered) });
    check(
      r.is_error === true && /covered/i.test(textOf(r)) && /read_page|scroll|overlay/.test(textOf(r)),
      'click on a covered ref refused with guidance',
    );
    r = await call('left_click', { target: at(5000, 10) });
    check(r.is_error === true, 'click outside the viewport refused');

    r = await call('find', { query: 'Hover zone' });
    r = await call('hover', { target: ref(refOn(textOf(r), /Hover zone/)) });
    if (r.is_error) {
      const zone = await centreOf('#hover');
      await call('hover', { target: at(zone.x, zone.y) });
    }
    check(/hovered;/.test(textOf(await call('get_page_text'))), 'hover fires mouseover');

    // --- dialogs -------------------------------------------------------------------------------------------------------
    r = await call('left_click', { target: ref(refOn(tree, /button "Alert me"/)) });
    check(
      !r.is_error && /alert dialog "Hello from alert" was dismissed/.test(textOf(r)),
      'alert dismissed and reported',
    );
    r = await call('left_click', { target: ref(refOn(tree, /button "Confirm me"/)) });
    check(
      !r.is_error && /confirm dialog "Delete everything\?" was dismissed/.test(textOf(r)),
      'confirm dismissed and reported',
    );
    await call('left_click', { target: ref(button) });
    r = await call('get_page_text');
    check(
      /confirm returned false/.test(textOf(r)) && /clicked 4 times/.test(textOf(r)),
      'page still responsive after the dialogs',
    );

    // --- popups and tabs -----------------------------------------------------------------------------------------------
    r = await call('left_click', { target: ref(refOn(tree, /button "Open popup"/)) });
    const popup = activeTab(r);
    check(
      popup !== 'tab_1' && changeTypes(r).includes('tab_opened') && stateOf(r)?.tabs.length === 2,
      'window.open: tab_opened, popup active',
    );
    r = await call('get_page_text');
    check(/This page opened in a new tab/.test(textOf(r)), 'the active tab reads the popup');
    r = await call('get_page_text', { tab_id: 'tab_1' });
    check(/Exercise page/.test(textOf(r)), 'tab_id reads another tab');
    r = await call('screenshot', { tab_id: 'tab_1' });
    check(
      !r.is_error && hasImage(r) && (timings.at(-1)?.ms ?? 1e9) < 5_000,
      'screenshot of a background tab by tab_id',
    );
    r = await call('switch_tab', { tab_id: 'tab_1' });
    check(activeTab(r) === 'tab_1', 'switch_tab back to tab_1');
    r = await call('close_tab', { tab_id: popup ?? 'tab_2' });
    check(!r.is_error && stateOf(r)?.tabs.length === 1, 'close_tab closes the popup');
    r = await call('close_tab', { tab_id: '' });
    check(r.is_error === true && /name the tab/.test(textOf(r)), 'close_tab with an empty tab_id refused');

    // A popup the page opens between calls: the next call without tab_id still goes to the tab last reported active.
    r = await call('left_click', { target: ref(refOn(tree, /button "Delayed popup"/)) });
    await sleep(2_500);
    r = await call('get_page_text');
    const late = activeTab(r);
    check(
      /Exercise page/.test(textOf(r)) && late !== 'tab_1' && changeTypes(r).includes('tab_opened'),
      'a popup opened between calls does not take the call; the next report shows it active',
    );
    r = await call('close_tab', { tab_id: late ?? 'tab_3' });

    r = await call('left_click', { target: ref(refOn(tree, /link "Blank link"/)) });
    const blank = activeTab(r);
    check(blank !== 'tab_1' && changeTypes(r).includes('tab_opened'), 'target=_blank link: tab_opened, new tab active');
    r = await call('close_tab', { tab_id: blank ?? 'tab_3' });
    check(activeTab(r) === 'tab_1' && stateOf(r)?.tabs.length === 1, 'closing the active tab activates tab_1');
    r = await call('close_tab', { tab_id: 'tab_1' });
    check(r.is_error === true, 'closing the last tab refused');
    r = await call('new_tab');
    const fresh = activeTab(r);
    check(!r.is_error && fresh !== 'tab_1' && changeTypes(r).includes('tab_opened'), 'new_tab opens an active tab');
    await call('close_tab', { tab_id: fresh ?? 'tab_4' });
    r = await call('screenshot', { tab_id: 'tab_99' });
    check(r.is_error === true, 'an unknown tab_id refused');

    // --- forms and keys ------------------------------------------------------------------------------------------------
    r = await call('form_input', { target: ref(nameRef), value: 'Drew' });
    check(!r.is_error, 'form_input on a text field');
    r = await call('form_input', { target: ref(agreeRef), value: true });
    check(!r.is_error, 'form_input on a checkbox');
    r = await call('form_input', { target: ref(sizeRef), value: 'Large' });
    check(!r.is_error, 'form_input on a select, by visible text');
    r = await call('form_input', { target: ref(sizeRef), value: 'Huge' });
    check(r.is_error === true && /disabled/i.test(textOf(r)), 'form_input refuses a disabled option');
    r = await call('get_page_text');
    check(/Name: Drew; Agree: yes; Size: Large/.test(textOf(r)), 'get_page_text shows the form_input values');

    await call('left_click', { target: ref(nameRef) });
    await call('key', { text: 'ctrl+a' });
    await call('key', { text: 'BackSpace' });
    r = await call('get_page_text');
    check(/Name: \(empty\)/.test(textOf(r)), "key 'ctrl+a' then 'BackSpace' clears the field");
    await call('type', { text: 'Grace Hopper' });
    await call('key', { text: 'Left', repeat: 6 });
    await call('type', { text: 'B. ' });
    r = await call('get_page_text');
    check(/Name: Grace B\. Hopper;/.test(textOf(r)), 'type, then key Left x6 moves the caret');
    r = await call('key', { text: 'nosuchkey' });
    check(r.is_error === true, 'an unknown key refused');
    r = await call('hold_key', { text: 'shift', duration: 0.3 });
    check(
      !r.is_error && /keydown Shift; keyup Shift;/.test(textOf(await call('get_page_text'))),
      'hold_key presses and releases',
    );
    r = await call('hold_key', { text: 'a', duration: 31 });
    check(r.is_error === true, 'hold_key over 30 s refused');

    // --- canvas drawing ------------------------------------------------------------------------------------------------
    const pad = await centreOf('#pad');
    const before = await inkedPixels();
    r = await call('left_click_drag', { from: at(pad.x - 120, pad.y - 40), target: at(pad.x + 120, pad.y + 40) });
    const afterDrag = await inkedPixels();
    check(
      !r.is_error && afterDrag > before + 200,
      `left_click_drag draws on the canvas (${before} -> ${afterDrag} inked pixels)`,
    );
    await call('left_mouse_down', { target: at(pad.x - 120, pad.y + 40) });
    await call('mouse_move', { target: at(pad.x, pad.y + 45) });
    await call('mouse_move', { target: at(pad.x + 120, pad.y - 40) });
    r = await call('left_mouse_up', { target: at(pad.x + 120, pad.y - 40) });
    const afterManual = await inkedPixels();
    check(
      !r.is_error && afterManual > afterDrag + 200,
      `mouse down, move, up draws too (${afterDrag} -> ${afterManual})`,
    );

    // --- scrolling -----------------------------------------------------------------------------------------------------
    await call('scroll', { target: at(640, 400), scroll_direction: 'down', scroll_amount: 5 });
    await call('wait', { duration: 1 }); // wheel scrolling finishes asynchronously
    const scrolled = Number(await evaluate('window.scrollY'));
    check(scrolled >= 300, `scroll down moves the page (scrollY ${scrolled})`);
    await call('scroll', { target: at(640, 400), scroll_direction: 'up', scroll_amount: 10 });
    await call('wait', { duration: 1 });
    const back = Number(await evaluate('window.scrollY'));
    check(back < scrolled, `scroll up moves it back (scrollY ${back})`);
    r = await call('find', { query: 'Hover zone' });
    r = await call('scroll_to', { target: ref(refOn(textOf(r), /Hover zone/)) });
    check(!r.is_error, 'scroll_to a ref');
    await evaluate('window.scrollTo(0, 0); window.scrollY');

    // --- console and network -------------------------------------------------------------------------------------------
    await call('read_console'); // drop what the earlier loads logged
    await call('read_network');
    r = await call('left_click', { target: ref(fetchRef) });
    await call('wait', { duration: 0.5 });
    r = await call('read_console');
    check(/fetched 42/.test(textOf(r)), 'read_console shows the console.log');
    r = await call('read_network');
    check(/\/data\.json/.test(textOf(r)), 'read_network lists the fetch');

    // --- download ------------------------------------------------------------------------------------------------------
    r = await call('left_click', { target: ref(refOn(tree, /link "Download file"/)) });
    let downloads = changeTypes(r);
    if (!downloads.includes('download_completed')) {
      r = await call('wait', { duration: 2 });
      downloads = downloads.concat(changeTypes(r));
    }
    // The SDK keeps the latest change per download_id, so a download that starts and finishes within one call is
    // reported once, as download_completed.
    check(downloads.includes('download_completed'), `download reported as completed (${downloads.join(', ')})`);

    // --- refused navigations -------------------------------------------------------------------------------------------
    r = await call('left_click', { target: ref(refOn(tree, /button "Leave for another host"/)) });
    check(/A navigation was refused/.test(textOf(r)), 'page-started navigation to a refused host reported as refused');
    r = await call('navigate', { url: 'javascript:alert(1)' });
    check(r.is_error === true, 'navigate to javascript: refused');
    r = await call('navigate', { url: 'file:///etc/passwd' });
    check(r.is_error === true, 'navigate to file: refused');
    r = await call('navigate', { url: 'http://127.0.0.1:8000/' });
    check(r.is_error === true && /blocked/.test(textOf(r)), 'navigate to a host outside the policy refused');
    r = await call('navigate', { url: 'https://example.com' });
    check(!r.is_error && /Example Domain/.test(textOf(r)), 'example.com reachable (policy and egress allow it)');
    r = await call('navigate', { url: 'https://iana.org' });
    check(
      r.is_error === true && /egress/.test(textOf(r)),
      'a host the policy admits but egress denies: the error says egress',
    );
    r = await call('list_tabs');
    check(
      /Failed to load/.test(stateOf(r)?.tabs.find((tab) => tab.active === true)?.title ?? ''),
      'the failed tab says so in its title',
    );
    r = await call('navigate', { url: `${ORIGIN}/jsredirect.html` });
    check(!r.is_error && /Second page/.test(textOf(r)), 'navigate to a page that redirects itself with script');
    await call('read_network');
    r = await call('navigate', { url: `${ORIGIN}/local.html` });
    r = await call('read_network');
    check(
      /failed \(net::ERR_BLOCKED_BY_CLIENT[^)]*\) http:\/\/127\.0\.0\.1:8000\/file\.txt/.test(textOf(r)),
      'a subresource on a local address outside the policy refused',
    );
    r = await call('javascript_exec', { text: "new Promise((resolve) => setTimeout(() => resolve('resolved'), 50))" });
    check(textOf(r).trim().startsWith('resolved'), 'javascript_exec awaits a promise it ends with');

    // --- stale refs and history ----------------------------------------------------------------------------------------
    await call('navigate', { url: `${ORIGIN}/` });
    r = await call('find', { query: 'Next page link' });
    const next = refOn(textOf(r), /Next page/);
    await call('left_click', { target: ref(next) });
    r = await call('get_page_text');
    check(/You reached page two/.test(textOf(r)), 'clicking a link waits for the new page');
    r = await call('left_click', { target: ref(next) });
    check(
      r.is_error === true && /read_page|find/.test(textOf(r)),
      'a stale ref after navigation refused with guidance',
    );
    await call('read_page', { filter: 'all' }); // the new page hands out refs too; the old ones must still not match
    r = await call('left_click', { target: ref(button) });
    check(
      r.is_error === true && /not a known element/.test(textOf(r)),
      'a ref from an earlier page never names an element of the new one',
    );
    r = await call('navigate', { url: 'back' });
    check(/Exercise page/.test(textOf(r)), 'navigate back after a link click');
    r = await call('navigate', { url: 'forward' });
    check(/Second page/.test(textOf(r)), 'navigate forward');
    r = await call('navigate', { url: 'reload' });
    check(!r.is_error && /Second page/.test(textOf(r)), 'navigate reload');

    // --- limits --------------------------------------------------------------------------------------------------------
    r = await call('wait', { duration: 31 });
    check(r.is_error === true, 'wait for longer than 30 s refused');

    // --- uploads: policy, confirmation, lazy reads, binary documents, and cleanup -------------------------------
    await call('navigate', { url: `${ORIGIN}/` });
    r = await call('read_page', { filter: 'all' });
    const uploadTree = textOf(r);
    const singleFile = refOn(uploadTree, /Upload single/);
    const multipleFiles = refOn(uploadTree, /Upload multiple/);
    const disabledFile = refOn(uploadTree, /Upload disabled/);
    check(Boolean(singleFile && multipleFiles && disabledFile), 'file inputs have refs');
    r = await call('file_upload', { target: ref(singleFile), paths: [localFile] });
    check(!r.is_error, 'policy-approved local file uploads');
    await call('wait', { duration: 0.2 });
    check(
      (await evaluate('document.getElementById("singleFile").files[0].text()')) === 'local upload content',
      'file contents remain readable after file_upload returns',
    );
    r = await call('file_upload', {
      target: ref(multipleFiles),
      paths: [localFile],
      document_ids: ['document-one', 'document-two'],
    });
    check(!r.is_error, 'mixed local paths and staged documents upload');
    check(
      JSON.stringify(
        JSON.parse(await evaluate('Array.from(document.getElementById("multipleFiles").files).map(f=>f.name)')),
      ) === '["approved.txt","note.txt","note.txt"]',
      'duplicate basenames preserved in separate staging directories',
    );
    check(
      JSON.stringify(
        JSON.parse(
          await evaluate(
            'document.getElementById("multipleFiles").files[2].arrayBuffer().then(b=>Array.from(new Uint8Array(b)))',
          ),
        ),
      ) === '[0,1,255,128]',
      'binary document contents preserved',
    );
    r = await call('file_upload', { target: ref(singleFile), document_ids: ['document-one', 'document-two'] });
    check(r.is_error === true, 'multiple files refused on a single-file input');
    r = await call('file_upload', { target: ref(disabledFile), paths: [localFile] });
    check(r.is_error === true, 'disabled file input refused');
    r = await call('file_upload', { target: ref(singleFile), document_ids: ['not-staged'] });
    check(r.is_error === true && /staged/.test(textOf(r)), 'allowed document ID without application bytes refused');
    const confirmedBefore = uploadConfirms;
    r = await call('file_upload', { target: ref(singleFile), paths: ['/etc/passwd'] });
    check(r.is_error === true && uploadConfirms === confirmedBefore, 'outside-root path refused before confirmation');
    r = await call('file_upload', { target: ref(singleFile), document_ids: ['not-approved'] });
    check(
      r.is_error === true && uploadConfirms === confirmedBefore,
      'unapproved document ID refused before confirmation',
    );
    approveUpload = false;
    r = await call('file_upload', { target: ref(singleFile), document_ids: ['document-one'] });
    check(r.is_error === true, 'confirmation rejection prevents upload');
    approveUpload = true;
    check(
      (await evaluate('document.getElementById("singleFile").files[0].name')) === 'approved.txt',
      'refused calls leave the previous selection intact',
    );
    await call('navigate', { url: `${ORIGIN}/page2.html` });
    r = await call('file_upload', { target: ref(singleFile), paths: [localFile] });
    check(r.is_error === true, 'stale file-input ref refused after navigation');

    const missing = MEMBERS.filter((member) => !called.has(member));
    check(missing.length === 0, `every implemented member called (missing: ${missing.join(', ') || 'none'})`);
  } finally {
    try {
      await browser.close();
      const cleanup = await desktop.sandbox.commands.run('find /tmp -maxdepth 1 -name "e2b-browser-upload.*" -type d');
      check(cleanup.stdout.trim() === '', 'upload staging removed on close of attached browser');
    } finally {
      await desktop.kill();
      rmSync(uploadRoot, { recursive: true, force: true });
    }
  }

  const byMember = new Map<string, number[]>();
  for (const { name, ms } of timings) byMember.set(name, [...(byMember.get(name) ?? []), ms]);
  console.log(
    `\nTimings: sandbox and Chrome start ${(startMs / 1000).toFixed(1)} s, total ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );
  for (const [name, list] of [...byMember].sort()) {
    const sorted = [...list].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    console.log(
      `  ${name.padEnd(16)} n=${String(list.length).padStart(2)} median ${median} ms, max ${sorted.at(-1) ?? 0} ms`,
    );
  }
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} checks failed.`);
  if (failures > 0) process.exitCode = 1;
}

if (import.meta.main)
  exercise((opts) => DesktopSDK.create(opts)).catch((error: unknown) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
