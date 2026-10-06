/**
 * Claude's computer toolset (`computer_toolset_20260801`) on an E2B desktop sandbox.
 *
 * Where the browser toolset drives one Chrome over CDP, this one drives the whole desktop: screenshots and mouse and
 * keyboard input on its X display, through `xdotool` and `scrot` inside the sandbox. The model reads the screenshots
 * and decides where to click, so the driver stays thin: each member maps to one or two commands.
 *
 * Members not overridden here (`zoom`) are switched off by the SDK, so the model is never offered them.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { checkScreen, pngSize } from './screen.ts';
import type { Sandbox as Desktop } from '@e2b/desktop';
import {
  BetaAbstractComputerToolset20260801,
  ToolError,
  type BetaComputerCursorPositionResult,
  type BetaComputerToolsetOptions,
  type BetaToolsetCallContext as Ctx,
} from '@anthropic-ai/sdk/helpers/beta/toolsets';
import type {
  BetaComputerDoubleClickInput,
  BetaComputerHoldKeyInput,
  BetaComputerKeyInput,
  BetaComputerLeftClickDragInput,
  BetaComputerLeftClickInput,
  BetaComputerMiddleClickInput,
  BetaComputerMouseMoveInput,
  BetaComputerRightClickInput,
  BetaComputerScrollInput,
  BetaComputerTripleClickInput,
  BetaComputerTypeInput,
  BetaComputerWaitInput,
} from '@anthropic-ai/sdk/resources/beta';

const SETTLE_MS = 300; // after an action, let the desktop draw before the next screenshot
// Out-of-range values are refused, never capped, so the model is not told an action ran as asked when it did not.
// Duration and repeat match the browser toolset; a computer scroll unit is one mouse-wheel click.
const MAX_DURATION_S = 30;
const MAX_REPEAT = 100;
const MAX_SCROLL = 50;
const KEY = /^[A-Za-z0-9_]+$/; // an X keysym name or single letter/digit, one part of a chord such as ctrl+s

type Click = { coordinate?: Array<number> | null; text?: string | null };

/** Keys the model writes differently from X keysym names. */
const ALIASES: Record<string, string> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  shift: 'shift',
  cmd: 'super',
  super: 'super',
  meta: 'super',
  win: 'super',
  enter: 'Return',
  return: 'Return',
  esc: 'Escape',
  escape: 'Escape',
  backspace: 'BackSpace',
  delete: 'Delete',
  tab: 'Tab',
  space: 'space',
  pageup: 'Page_Up',
  pagedown: 'Page_Down',
};

export type E2BComputerOptions = BetaComputerToolsetOptions;

export class E2BComputerToolset extends BetaAbstractComputerToolset20260801 {
  /** Set from left_mouse_down until the button is released, so close() does not leave the desktop mid-drag. */
  #buttonHeld = false;
  /** Chords sent down by hold_key and not yet confirmed released. */
  readonly #heldKeys = new Set<string>();

  private constructor(
    /** The desktop sandbox the toolset drives. It is yours: `close()` leaves it running. */
    readonly desktop: Desktop,
    readonly width: number,
    readonly height: number,
    options: E2BComputerOptions,
  ) {
    super(options);
  }

  /**
   * Attach to a running `@e2b/desktop` sandbox. Reads the screen size once; screenshots are sent at that size, so it
   * should stay within the model's image limits (1280x800 is a good fit).
   */
  static async create(desktop: Desktop, options: E2BComputerOptions = {}): Promise<E2BComputerToolset> {
    const { width, height } = await desktop.getScreenSize();
    checkScreen('desktop resolution', width, height);
    return new E2BComputerToolset(desktop, width, height, options);
  }

  protected override async screenshot(): Promise<{ data: string }> {
    await sleep(SETTLE_MS);
    const image = await desktopCall('Could not take a screenshot of the desktop.', () => this.desktop.screenshot());
    const { width, height } = pngSize(image);
    if (width !== this.width || height !== this.height)
      throw new ToolError(
        `The screen is now ${width}x${height}, not ${this.width}x${this.height}; create the toolset again.`,
      );
    return { data: Buffer.from(image).toString('base64') };
  }

  protected override async cursor_position(): Promise<BetaComputerCursorPositionResult> {
    return desktopCall('Could not read the cursor position.', () => this.desktop.getCursorPosition());
  }

  protected override async mouse_move(_ctx: Ctx, input: BetaComputerMouseMoveInput): Promise<void> {
    await this.xdotool(this.move(input.coordinate));
  }

  protected override async left_click(_ctx: Ctx, input: BetaComputerLeftClickInput): Promise<void> {
    await this.click(input, 1, 1);
  }

  protected override async right_click(_ctx: Ctx, input: BetaComputerRightClickInput): Promise<void> {
    await this.click(input, 3, 1);
  }

  protected override async middle_click(_ctx: Ctx, input: BetaComputerMiddleClickInput): Promise<void> {
    await this.click(input, 2, 1);
  }

  protected override async double_click(_ctx: Ctx, input: BetaComputerDoubleClickInput): Promise<void> {
    await this.click(input, 1, 2);
  }

  protected override async triple_click(_ctx: Ctx, input: BetaComputerTripleClickInput): Promise<void> {
    await this.click(input, 1, 3);
  }

  protected override async left_mouse_down(): Promise<void> {
    this.#buttonHeld = true; // before the command: if it fails part-way, close() still releases
    await this.xdotool('mousedown 1');
  }

  protected override async left_mouse_up(): Promise<void> {
    await this.xdotool('mouseup 1');
    this.#buttonHeld = false;
  }

  /**
   * Wait for calls in flight, then release keys and the mouse button left down. The desktop is yours and stays
   * running. If a release fails, this throws and calling it again retries.
   */
  override async close(): Promise<void> {
    await super.close();
    for (const keys of [...this.#heldKeys])
      await this.xdotool(`keyup ${keys}`).then(
        () => this.#heldKeys.delete(keys),
        () => undefined,
      );
    if (this.#buttonHeld)
      await this.xdotool('mouseup 1').then(
        () => (this.#buttonHeld = false),
        () => undefined,
      );
    if (this.#heldKeys.size > 0 || this.#buttonHeld)
      throw new Error('Could not release input held on the desktop; call close() again to retry');
  }

  protected override async left_click_drag(_ctx: Ctx, input: BetaComputerLeftClickDragInput): Promise<void> {
    const command = `${this.move(input.start_coordinate)} mousedown 1 ${this.move(input.coordinate)} mouseup 1`;
    this.#buttonHeld = true; // until a release is confirmed; close() retries it
    await this.withModifiers(input.text, command).catch(async (error: unknown) => {
      await this.xdotool('mouseup 1').then(
        () => (this.#buttonHeld = false),
        () => undefined,
      );
      throw error;
    });
    this.#buttonHeld = false;
  }

  protected override async scroll(_ctx: Ctx, input: BetaComputerScrollInput): Promise<void> {
    const button = { up: 4, down: 5, left: 6, right: 7 }[input.scroll_direction];
    const amount = checkInteger(input.scroll_amount, 'scroll_amount', MAX_SCROLL);
    const move = input.coordinate ? `${this.move(input.coordinate)} ` : '';
    await this.withModifiers(input.text, `${move}click --repeat ${amount} --delay 20 ${button}`);
  }

  protected override async key(_ctx: Ctx, input: BetaComputerKeyInput): Promise<void> {
    const repeat = checkInteger(input.repeat ?? 1, 'repeat', MAX_REPEAT);
    await this.xdotool(`key --clearmodifiers --repeat ${repeat} --delay 50 ${chord(input.text)}`);
  }

  protected override async hold_key(ctx: Ctx, input: BetaComputerHoldKeyInput): Promise<void> {
    const keys = chord(input.text);
    const seconds = checkDuration(input.duration);
    this.#heldKeys.add(keys); // before keydown: if its reply is lost, the key may be down anyway
    try {
      await this.xdotool(`keydown ${keys}`);
      await sleep(seconds * 1000, undefined, abortable(ctx)); // a stopped run lets go at once
    } finally {
      await this.xdotool(`keyup ${keys}`);
      this.#heldKeys.delete(keys);
    }
  }

  protected override async type_(_ctx: Ctx, input: BetaComputerTypeInput): Promise<void> {
    await desktopCall('Typing on the desktop failed part-way; take a screenshot to see what was typed.', () =>
      this.desktop.write(input.text, { chunkSize: 50, delayInMs: 12 }),
    );
  }

  protected override async wait(ctx: Ctx, input: BetaComputerWaitInput): Promise<void> {
    await sleep(checkDuration(input.duration) * 1000, undefined, abortable(ctx));
  }

  /** `mousemove x y` for a coordinate on the screen; anything else is refused before it reaches the desktop. */
  private move(coordinate: Array<number> | null | undefined): string {
    const [x, y] = coordinate ?? [];
    if (x === undefined || y === undefined || !Number.isInteger(x) || !Number.isInteger(y))
      throw new ToolError('coordinate must be two integers');
    if (x < 0 || y < 0 || x >= this.width || y >= this.height)
      throw new ToolError(`coordinate (${x}, ${y}) is outside the ${this.width}x${this.height} screen`);
    return `mousemove ${x} ${y}`;
  }

  private async click(input: Click, button: number, count: number): Promise<void> {
    const move = input.coordinate ? `${this.move(input.coordinate)} ` : '';
    await this.withModifiers(input.text, `${move}click --repeat ${count} --delay 80 ${button}`);
  }

  /** Run an xdotool command with modifier keys (the input's `text`, such as `shift` or `ctrl+alt`) held during it. */
  private async withModifiers(text: string | null | undefined, command: string): Promise<void> {
    if (!text) return this.xdotool(command);
    const keys = chord(text);
    this.#heldKeys.add(keys); // until a release is confirmed; close() retries it
    await this.xdotool(`keydown ${keys} ${command} keyup ${keys}`).catch(async (error: unknown) => {
      await this.xdotool(`keyup ${keys}`).then(
        () => this.#heldKeys.delete(keys),
        () => undefined,
      );
      throw error;
    });
    this.#heldKeys.delete(keys);
  }

  private async xdotool(command: string): Promise<void> {
    await desktopCall('The desktop did not accept the input; take a screenshot to check the screen.', () =>
      this.desktop.commands.run(`xdotool ${command}`, { timeoutMs: 15_000 }),
    );
  }
}

/** Sleep options that end the sleep when the run is stopped (the runner's abort signal). */
function abortable(ctx: Ctx): { signal?: AbortSignal } {
  return ctx.signal ? { signal: ctx.signal } : {};
}

async function desktopCall<T>(message: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(message);
  }
}

/** A duration in seconds, from 0 to 30; refused otherwise, as the browser toolset does. */
function checkDuration(value: unknown): number {
  if (typeof value !== 'number' || !(value >= 0 && value <= MAX_DURATION_S))
    throw new ToolError(`duration: must be between 0 and ${MAX_DURATION_S} seconds`);
  return value;
}

/** A whole number from 1 to `max`; refused otherwise. */
function checkInteger(value: unknown, field: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max)
    throw new ToolError(`${field}: must be an integer from 1 to ${max}`);
  return value;
}

/** A chord such as `ctrl+s` or `Return` as xdotool key names; refuses anything that is not a plain key name. */
function chord(text: string): string {
  const parts = text.split('+').map((part) => part.trim());
  if (!parts.length || parts.some((part) => !KEY.test(part))) throw new ToolError(`not a key name: ${text}`);
  return parts.map((part) => ALIASES[part.toLowerCase()] ?? part).join('+');
}
