/**
 * Mouse and keyboard input over CDP `Input.*` for one tab.
 *
 * Every helper takes a per-tab `send` function, so this module holds no state and knows nothing about sockets or
 * sessions. Key names follow xdotool (the names the model uses for `key`, `hold_key` and friends: `Return`,
 * `ctrl+a`, `Page_Down`) and also accept DOM key names (`Enter`, `ArrowLeft`, `PageDown`). The key table assumes a US
 * layout.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { ToolError } from '@anthropic-ai/sdk/helpers/beta/toolsets';

/** Sends one CDP command to the tab the input is meant for. */
export type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export interface Point {
  x: number;
  y: number;
}

export type MouseButton = 'left' | 'right' | 'middle';

// CDP modifier bits.
const ALT = 1;
const CTRL = 2;
const META = 4;
const SHIFT = 8;

/** The CDP `buttons` bit for each button, reported while it is held. */
const BUTTON_BITS: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 };

const WHEEL_TICK_PX = 100;

/** One key of the table. `shift` marks keys that imply Shift (`A`, `!`, `ISO_Left_Tab`); `modifier` marks modifier keys. */
interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  shiftKey?: string; // the `key` (and text) the key produces with Shift held, for printable keys
  shift?: boolean;
  modifier?: number;
  location?: number;
}

/** Exact names (case-sensitive: `a` and `A` differ) and lowercased aliases, both pointing into the same defs. */
const EXACT = new Map<string, KeyDef>();
const ALIASES = new Map<string, KeyDef>();

function define(def: KeyDef, ...names: string[]): void {
  EXACT.set(def.key, def);
  for (const name of names) ALIASES.set(name.toLowerCase(), def);
}

function definePrintable(
  base: string,
  shifted: string,
  code: string,
  keyCode: number,
  baseNames: string[],
  shiftedNames: string[],
): void {
  define({ key: base, code, keyCode, text: base, shiftKey: shifted }, ...baseNames);
  define({ key: shifted, code, keyCode, text: shifted, shift: true }, ...shiftedNames);
}

for (let i = 0; i < 26; i++) {
  const lower = String.fromCharCode(97 + i);
  const upper = lower.toUpperCase();
  const code = `Key${upper}`;
  // letters resolve exactly (a vs A); no case-insensitive alias, or `A` would lose its Shift
  EXACT.set(lower, { key: lower, code, keyCode: 65 + i, text: lower, shiftKey: upper });
  EXACT.set(upper, { key: upper, code, keyCode: 65 + i, text: upper, shift: true });
}

const DIGIT_SHIFTED = ')!@#$%^&*(';
const DIGIT_SHIFTED_NAMES = [
  'parenright',
  'exclam',
  'at',
  'numbersign',
  'dollar',
  'percent',
  'asciicircum',
  'ampersand',
  'asterisk',
  'parenleft',
];
for (let d = 0; d <= 9; d++) {
  definePrintable(String(d), DIGIT_SHIFTED[d]!, `Digit${d}`, 48 + d, [], [DIGIT_SHIFTED_NAMES[d]!]);
}

definePrintable('-', '_', 'Minus', 189, ['minus'], ['underscore']);
definePrintable('=', '+', 'Equal', 187, ['equal'], ['plus']);
definePrintable('[', '{', 'BracketLeft', 219, ['bracketleft'], ['braceleft']);
definePrintable(']', '}', 'BracketRight', 221, ['bracketright'], ['braceright']);
definePrintable('\\', '|', 'Backslash', 220, ['backslash'], ['bar']);
definePrintable(';', ':', 'Semicolon', 186, ['semicolon'], ['colon']);
definePrintable("'", '"', 'Quote', 222, ['apostrophe', 'quoteright'], ['quotedbl']);
definePrintable(',', '<', 'Comma', 188, ['comma'], ['less']);
definePrintable('.', '>', 'Period', 190, ['period'], ['greater']);
definePrintable('/', '?', 'Slash', 191, ['slash'], ['question']);
definePrintable('`', '~', 'Backquote', 192, ['grave', 'quoteleft'], ['asciitilde']);
define({ key: ' ', code: 'Space', keyCode: 32, text: ' ' }, 'space', 'spacebar');

define({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' }, 'Return', 'Enter', 'linefeed');
ALIASES.set('kp_enter', { key: 'Enter', code: 'NumpadEnter', keyCode: 13, text: '\r', location: 3 });
define({ key: 'Tab', code: 'Tab', keyCode: 9 }, 'Tab');
ALIASES.set('iso_left_tab', { key: 'Tab', code: 'Tab', keyCode: 9, shift: true });
define({ key: 'Backspace', code: 'Backspace', keyCode: 8 }, 'BackSpace');
define({ key: 'Delete', code: 'Delete', keyCode: 46 }, 'Delete', 'Del', 'KP_Delete');
define({ key: 'Escape', code: 'Escape', keyCode: 27 }, 'Escape', 'Esc');
define({ key: 'Insert', code: 'Insert', keyCode: 45 }, 'Insert', 'KP_Insert');
define({ key: 'Home', code: 'Home', keyCode: 36 }, 'Home', 'KP_Home');
define({ key: 'End', code: 'End', keyCode: 35 }, 'End', 'KP_End');
define({ key: 'PageUp', code: 'PageUp', keyCode: 33 }, 'PageUp', 'Page_Up', 'Prior', 'KP_Page_Up', 'KP_Prior');
define({ key: 'PageDown', code: 'PageDown', keyCode: 34 }, 'PageDown', 'Page_Down', 'Next', 'KP_Page_Down', 'KP_Next');
define({ key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }, 'ArrowLeft', 'Left', 'KP_Left');
define({ key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 }, 'ArrowUp', 'Up', 'KP_Up');
define({ key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 }, 'ArrowRight', 'Right', 'KP_Right');
define({ key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 }, 'ArrowDown', 'Down', 'KP_Down');
define({ key: 'CapsLock', code: 'CapsLock', keyCode: 20 }, 'CapsLock', 'Caps_Lock');
define({ key: 'ContextMenu', code: 'ContextMenu', keyCode: 93 }, 'ContextMenu', 'Menu');
define({ key: 'Pause', code: 'Pause', keyCode: 19 }, 'Pause');
define({ key: 'PrintScreen', code: 'PrintScreen', keyCode: 44 }, 'PrintScreen', 'Print');
for (let n = 1; n <= 24; n++) define({ key: `F${n}`, code: `F${n}`, keyCode: 111 + n }, `F${n}`);

// Modifier keys, both as keys to press and as chord prefixes.
define({ key: 'Shift', code: 'ShiftLeft', keyCode: 16, modifier: SHIFT, location: 1 }, 'Shift', 'Shift_L');
define(
  { key: 'Control', code: 'ControlLeft', keyCode: 17, modifier: CTRL, location: 1 },
  'Control',
  'Control_L',
  'ctrl',
);
define({ key: 'Alt', code: 'AltLeft', keyCode: 18, modifier: ALT, location: 1 }, 'Alt', 'Alt_L', 'option');
define(
  { key: 'Meta', code: 'MetaLeft', keyCode: 91, modifier: META, location: 1 },
  'Meta',
  'Meta_L',
  'Super_L',
  'Super',
  'cmd',
  'command',
  'win',
);
ALIASES.set('shift_r', { key: 'Shift', code: 'ShiftRight', keyCode: 16, modifier: SHIFT, location: 2 });
ALIASES.set('control_r', { key: 'Control', code: 'ControlRight', keyCode: 17, modifier: CTRL, location: 2 });
ALIASES.set('alt_r', { key: 'Alt', code: 'AltRight', keyCode: 18, modifier: ALT, location: 2 });
for (const name of ['meta_r', 'super_r'])
  ALIASES.set(name, { key: 'Meta', code: 'MetaRight', keyCode: 92, modifier: META, location: 2 });

function lookup(name: string): KeyDef | undefined {
  return EXACT.get(name) ?? ALIASES.get(name.toLowerCase());
}

/** Looks up one key name (xdotool keysym or DOM key). Returns undefined for a name the table lacks. */
export function keyDefinition(name: string): { key: string; code: string; keyCode: number; text?: string } | undefined {
  const def = lookup(name);
  if (def === undefined) return undefined;
  const { key, code, keyCode, text } = def;
  return text === undefined ? { key, code, keyCode } : { key, code, keyCode, text };
}

const MODIFIER_NAMES: Record<string, number> = {
  ctrl: CTRL,
  control: CTRL,
  shift: SHIFT,
  alt: ALT,
  option: ALT,
  meta: META,
  cmd: META,
  command: META,
  super: META,
  win: META,
};

/** Turns `'ctrl+shift'`-style text into the CDP modifier bitmask; empty or missing text is 0. */
export function parseModifiers(text: string | null | undefined): number {
  let bits = 0;
  for (const raw of (text ?? '').split('+')) {
    const name = raw.trim().toLowerCase();
    if (name === '') continue;
    const bit = MODIFIER_NAMES[name];
    if (bit === undefined) throw new ToolError(`Unknown modifier: ${raw.trim()}`);
    bits |= bit;
  }
  return bits;
}

/** One parsed chord: the modifier keys in the order given, then the main key. */
interface Chord {
  modifiers: KeyDef[];
  main: KeyDef;
}

/** Splits `'ctrl+a Return'` into chords. A `+` that ends a chord is the plus key (`ctrl++`). */
function parseChords(text: string): Chord[] {
  const chords: Chord[] = [];
  for (const chord of text.trim().split(/\s+/)) {
    if (chord === '') continue;
    const parts = chord.split(/\+(?=.)/);
    const defs = parts.map((part) => {
      const def = lookup(part);
      if (def === undefined) throw new ToolError(`Unknown key: ${part}`);
      return def;
    });
    const main = defs.pop()!;
    for (const [i, def] of defs.entries()) {
      if (def.modifier === undefined) throw new ToolError(`Unknown key: ${parts[i]}`);
    }
    chords.push({ modifiers: defs, main });
  }
  if (chords.length === 0) throw new ToolError('Unknown key: (empty)');
  return chords;
}

// Chrome's editing commands for Ctrl (or Cmd) shortcuts. A synthetic keyDown does not run the platform's shortcut
// handling, so without these ctrl+a / ctrl+c and friends do nothing in headless Linux Chrome.
const EDIT_COMMANDS: Record<string, string> = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo', y: 'redo' };

function editCommands(main: KeyDef, bits: number): string[] {
  // cmd/meta is sent as Meta (so pages see metaKey) and also gets the command, so macOS-style shortcuts the model
  // learned (cmd+a) still work on a Linux browser.
  if (!(bits & (CTRL | META)) || bits & ALT) return [];
  const letter = main.key.toLowerCase();
  if (letter === 'z' && bits & SHIFT) return ['redo'];
  const command = EDIT_COMMANDS[letter];
  return command === undefined ? [] : [command];
}

/** The keyDown/keyUp params for a key under the given modifier bits. */
function keyEvent(def: KeyDef, bits: number, type: 'keyDown' | 'keyUp'): Record<string, unknown> {
  const shifted = bits & SHIFT && def.shiftKey !== undefined;
  const key = shifted ? def.shiftKey! : def.key;
  // Text only for plain or shifted printable keys: ctrl+a must not type an "a".
  const text = def.text === undefined || bits & (CTRL | ALT | META) ? undefined : shifted ? def.shiftKey : def.text;
  // No nativeVirtualKeyCode: it is the platform's own scancode (X11, macOS), and a Windows code there makes Chrome
  // stall or act on the wrong key.
  const params: Record<string, unknown> = {
    type: type === 'keyUp' ? 'keyUp' : text === undefined ? 'rawKeyDown' : 'keyDown',
    key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    modifiers: bits,
  };
  if (def.location !== undefined) params['location'] = def.location;
  if (type === 'keyDown' && text !== undefined) {
    params['text'] = text;
    params['unmodifiedText'] = text;
  }
  return params;
}

const SHIFT_DEF = lookup('Shift')!;

/** Presses a chord's keys down in order and returns the release, which lifts them in reverse. */
async function chordDown(send: Send, chord: Chord): Promise<() => Promise<void>> {
  const held: KeyDef[] = [...chord.modifiers];
  if (chord.main.shift && !held.some((def) => def.modifier === SHIFT)) held.push(SHIFT_DEF);
  let bits = 0;
  for (const def of held) {
    bits |= def.modifier ?? 0;
    await send('Input.dispatchKeyEvent', keyEvent(def, bits, 'keyDown'));
  }
  const allBits = bits | (chord.main.modifier ?? 0);
  const down = keyEvent(chord.main, allBits, 'keyDown');
  const commands = editCommands(chord.main, bits);
  if (commands.length > 0) down['commands'] = commands;
  await send('Input.dispatchKeyEvent', down);
  return async () => {
    await send('Input.dispatchKeyEvent', keyEvent(chord.main, bits, 'keyUp'));
    for (let i = held.length - 1; i >= 0; i--) {
      const def = held[i]!;
      bits &= ~(def.modifier ?? 0);
      await send('Input.dispatchKeyEvent', keyEvent(def, bits, 'keyUp'));
    }
  };
}

/** Presses each space-separated chord of `text` in turn, the whole sequence `repeat` times. */
export async function pressKeys(send: Send, text: string, repeat: number): Promise<void> {
  const chords = parseChords(text);
  const times = Math.max(1, Math.floor(repeat));
  const batch = pipeline(send);
  for (let i = 0; i < times; i++) {
    for (const chord of chords) await (await chordDown(batch.send, chord))();
  }
  await batch.flush();
}

/** Holds the chord(s) of `text` down for `durationS` seconds, then releases in reverse. The caller bounds the duration. */
export async function holdKey(send: Send, text: string, durationS: number, signal?: AbortSignal | null): Promise<void> {
  const chords = parseChords(text);
  const releases: Array<() => Promise<void>> = [];
  const batch = pipeline(send);
  try {
    for (const chord of chords) releases.push(await chordDown(batch.send, chord));
    await batch.flush(); // the keys are down before the hold starts
    // a stopped run (the runner's abort signal) ends the hold at once; the keys are released below either way
    await sleep(Math.max(0, durationS) * 1000, undefined, signal ? { signal } : {});
  } finally {
    for (const release of releases.reverse()) await release();
    await batch.flush();
  }
}

/** Types text with `Input.insertText`, pressing Enter for each newline (so forms submit) and Tab for each tab. */
export async function typeText(send: Send, text: string): Promise<void> {
  const batch = pipeline(send);
  for (const piece of text.replace(/\r\n?/g, '\n').split(/([\n\t])/)) {
    if (piece === '\n') await pressKeys(batch.send, 'Return', 1);
    else if (piece === '\t') await pressKeys(batch.send, 'Tab', 1);
    else if (piece !== '') await batch.send('Input.insertText', { text: piece });
  }
  await batch.flush();
}

/**
 * A `send` that dispatches at once without waiting for the reply, and `flush()`, which waits for every reply and
 * throws the first failure. CDP runs a session's commands in order, so a sequence of events keeps its order while
 * costing one round trip instead of one per event (about 165 ms each from Europe to the US cluster).
 */
function pipeline(send: Send): { send: Send; flush: () => Promise<void> } {
  const pending: Array<Promise<void>> = [];
  let failure: { error: unknown } | undefined;
  return {
    send: (method, params) => {
      pending.push(
        send(method, params).then(
          () => undefined,
          (error: unknown) => {
            failure ??= { error };
          },
        ),
      );
      return Promise.resolve();
    },
    flush: async () => {
      await Promise.all(pending.splice(0));
      if (failure !== undefined) throw failure.error;
    },
  };
}

function mouse(send: Send, params: Record<string, unknown>): Promise<unknown> {
  return send('Input.dispatchMouseEvent', params);
}

/** Moves the pointer to `at`, reporting `buttons` (the CDP bitmask of held buttons) for a drag in progress. */
export async function mouseMove(send: Send, at: Point, buttons = 0): Promise<void> {
  await mouse(send, { type: 'mouseMoved', x: at.x, y: at.y, buttons, ...(buttons & 1 ? { button: 'left' } : {}) });
}

/** Moves the pointer to `at` without pressing anything. */
export async function hover(send: Send, at: Point): Promise<void> {
  await mouseMove(send, at);
}

/**
 * Clicks `clickCount` times at `at`. Each press/release pair carries the running count (1, 2, 3), which is how Chrome
 * recognizes a double click (dblclick, word select) or triple click (paragraph select).
 */
export async function click(
  send: Send,
  at: Point,
  opts: { button: MouseButton; clickCount: number; modifiers: number },
): Promise<void> {
  const { x, y } = at;
  const { button, modifiers } = opts;
  const batch = pipeline(send);
  await mouse(batch.send, { type: 'mouseMoved', x, y, modifiers });
  for (let count = 1; count <= Math.max(1, Math.floor(opts.clickCount)); count++) {
    const base = { x, y, button, clickCount: count, modifiers };
    await mouse(batch.send, { type: 'mousePressed', ...base, buttons: BUTTON_BITS[button] });
    await mouse(batch.send, { type: 'mouseReleased', ...base, buttons: 0 });
  }
  await batch.flush();
}

/** Presses the left button at `at` and leaves it down. */
export async function mouseDown(send: Send, at: Point): Promise<void> {
  const batch = pipeline(send);
  await mouse(batch.send, { type: 'mouseMoved', x: at.x, y: at.y });
  await mouse(batch.send, { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 });
  await batch.flush();
}

/** Releases the left button at `at`. */
export async function mouseUp(send: Send, at: Point): Promise<void> {
  const batch = pipeline(send);
  await mouse(batch.send, { type: 'mouseMoved', x: at.x, y: at.y, button: 'left', buttons: 1 });
  await mouse(batch.send, { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 });
  await batch.flush();
}

/**
 * Drags with the left button from `from` to `to` in small steps, so pages that track mousemove (canvas drawing,
 * sliders) see a path. Moves go out in groups of three: Chrome folds moves that arrive within one frame into one
 * event, so waiting between groups keeps several distinct points without paying a round trip for every step.
 */
export async function drag(send: Send, from: Point, to: Point): Promise<void> {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.min(50, Math.max(10, Math.ceil(distance / 20)));
  const batch = pipeline(send);
  await mouseDown(batch.send, from);
  await batch.flush();
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await mouseMove(batch.send, { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }, 1);
    if (i % 3 === 0) await batch.flush();
  }
  await mouseUp(batch.send, to);
  await batch.flush();
}

/** Scrolls at `at` by `amount` wheel ticks of 100 CSS px each. */
export async function wheel(
  send: Send,
  at: Point,
  direction: 'up' | 'down' | 'left' | 'right',
  amount: number,
): Promise<void> {
  const px = amount * WHEEL_TICK_PX;
  const deltaX = direction === 'left' ? -px : direction === 'right' ? px : 0;
  const deltaY = direction === 'up' ? -px : direction === 'down' ? px : 0;
  const batch = pipeline(send);
  await mouse(batch.send, { type: 'mouseMoved', x: at.x, y: at.y });
  await mouse(batch.send, { type: 'mouseWheel', x: at.x, y: at.y, deltaX, deltaY });
  await batch.flush();
}
