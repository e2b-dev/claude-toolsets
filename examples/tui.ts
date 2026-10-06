/**
 * Terminal output for the examples, injected so the examples stay plain package usage:
 *
 *   tools: [tui.trace(browser, { Task: task })]   header, then every tool call with its result and time
 *   tui.done(answer)                               Claude's answer, rendered, and a footer
 *   await tui.holdOpen('close the desktop')        wait for Enter so the live view stays up
 *
 * Presentation only; nothing here is part of the package. Colors turn off when piped or with NO_COLOR.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type Anthropic from '@anthropic-ai/sdk';
import type { E2BBrowserToolset, E2BComputerToolset } from '@e2b/claude-toolsets';

const startedAt = performance.now();
let calls = 0;

/**
 * Print the header, then log every call the tool runner makes on this toolset, with its result and time. Wraps the
 * toolset's `run` (the one method the runner calls per tool use) and returns the same toolset. A `Watch` row is also
 * opened in your browser when running in a terminal.
 */
export function trace<T extends Pick<E2BBrowserToolset | E2BComputerToolset, 'run' | 'type'>>(
  toolset: T,
  rows: Record<string, string>,
): T {
  header(rows, toolset.type.startsWith('computer') ? 'computer toolset' : 'browser toolset');
  if (rows['Watch'] && process.stdout.isTTY)
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [rows['Watch']], { stdio: 'ignore' })
      .on('error', () => {})
      .unref();
  const run = toolset.run.bind(toolset);
  toolset.run = async (ctx, toolUse) => {
    calls++;
    toolCall(toolUse);
    const started = performance.now();
    try {
      const content = await run(ctx, toolUse);
      toolResult(content, false, performance.now() - started);
      return content;
    } catch (error) {
      toolResult(error instanceof Error ? error.message : String(error), true, performance.now() - started);
      throw error; // the runner turns it into the is_error result Claude reads
    }
  };
  return toolset;
}

/** Claude's final message as the rendered answer, then the footer. */
export function done(message: Anthropic.Beta.BetaMessage): void {
  for (const part of message.content) if (part.type === 'text') answer(part.text);
  const seconds = ((performance.now() - startedAt) / 1000).toFixed(0);
  console.log(
    `\n  ${green('✓')} ${bold('Done')} ${dim(`in ${seconds}s · ${calls} tool call${calls === 1 ? '' : 's'}`)}`,
  );
}

/** In a terminal, wait for Enter before continuing; without one, continue at once. */
export async function holdOpen(what: string): Promise<void> {
  if (!process.stdin.isTTY) return;
  console.log(`\n  ${dim(`Press Enter to ${what}.`)}`);
  await once(process.stdin, 'data');
  process.stdin.pause();
}

const color = (process.stdout.isTTY || !!process.env['FORCE_COLOR']) && !process.env['NO_COLOR'];
const paint = (code: string) => (text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = paint('1');
const dim = paint('2');
const cyan = paint('36');
const green = paint('32');
const red = paint('31');
const magenta = paint('35');

const width = () => Math.min(process.stdout.columns || 100, 110);
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text);

/** The title card. Long values wrap under their column. */
function header(rows: Record<string, string>, kind: string): void {
  console.log(`\n  ${bold(magenta('E2B'))} ${dim('×')} ${bold('Claude')}  ${dim(kind)}`);
  console.log(`  ${dim('─'.repeat(Math.min(width() - 4, 60)))}`);
  for (const [label, value] of Object.entries(rows)) {
    const style = label === 'Watch' ? cyan : label === 'Sandbox' ? dim : (text: string) => text;
    const [first, ...rest] = wrapPlain(value, width() - 12);
    console.log(`  ${dim(label.padEnd(8))}  ${style(first ?? '')}`);
    for (const line of rest) console.log(`            ${style(line)}`);
  }
  console.log();
}

/** `● navigate  github.com/e2b-dev/E2B`: the argument that matters instead of raw JSON input. */
function toolCall(block: Anthropic.Beta.BetaToolUseBlock): void {
  const input = block.input as Record<string, unknown>;
  const target = input['target'] as { type?: string; ref?: string; x?: number; y?: number } | undefined;
  const key = ['query', 'text', 'value', 'key'].find((k) => typeof input[k] === 'string');
  const point = Array.isArray(input['coordinate']) ? `(${(input['coordinate'] as number[]).join(', ')})` : '';
  const scroll =
    typeof input['scroll_direction'] === 'string' ? `${input['scroll_direction']} ${input['scroll_amount']}` : '';
  const arg =
    [point, scroll, key ? `"${oneLine(String(input[key]))}"` : ''].filter(Boolean).join('  ') ||
    (typeof input['url'] === 'string'
      ? input['url'].replace(/^https?:\/\//, '').replace(/\/$/, '')
      : key
        ? `"${oneLine(String(input[key]))}"`
        : target?.type === 'ref'
          ? (target.ref ?? '')
          : target?.type === 'coordinate'
            ? `(${target.x}, ${target.y})`
            : JSON.stringify(input) === '{}'
              ? ''
              : JSON.stringify(input));
  console.log(`  ${cyan('●')} ${bold(block.name)}${arg ? `  ${clip(arg, width() - block.name.length - 8)}` : ''}`);
}

/** `  └  2.1s  Navigated to … (HTTP 200)`: what the browser sent back to Claude, one line. */
function toolResult(
  content: string | Anthropic.Beta.BetaToolResultBlockParam['content'],
  isError: boolean,
  ms: number,
): void {
  const parts = typeof content === 'string' ? [{ type: 'text' as const, text: content }] : (content ?? []);
  const shown: string[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      const text = oneLine(part.text).replace(/^- /, '');
      shown.push(text.length > 200 ? `${text.length.toLocaleString()} chars · ${text}` : text);
    } else if (part.type === 'image' && part.source.type === 'base64') {
      shown.push(`screenshot · ${Math.round((part.source.data.length * 3) / 4 / 1024)} KB`);
    } // browser_state (the tab report added to every result) is left out
  }
  const time = `${(ms / 1000).toFixed(1)}s`.padStart(5) + '  ';
  const line = clip(shown.join(' · ') || 'done', width() - 8 - time.length);
  console.log(`    ${dim('└')} ${dim(time)}${isError ? red(line) : dim(line)}`);
}

/** Claude's text: `**bold**`, `` `code` ``, `- ` bullets and headings, wrapped to the terminal with an indent. */
function answer(text: string): void {
  console.log(`\n  ${bold(green('Answer'))}\n`);
  for (const raw of text.trim().split('\n')) {
    const line = raw.trimEnd();
    if (!line) {
      console.log();
      continue;
    }
    const bullet = /^\s*[-*] /.exec(line);
    const heading = /^#+ /.exec(line);
    const body = line.slice((bullet ?? heading)?.[0].length ?? 0);
    const first = bullet ? `  ${green('•')} ` : '  ';
    const rest = bullet ? '    ' : '  ';
    wrapMarkdown(heading ? `**${body}**` : body, width() - rest.length - 2).forEach((part, i) =>
      console.log(`${i === 0 ? first : rest}${part}`),
    );
  }
}

/** Split text into lines of at most `max` characters, at spaces. */
function wrapPlain(text: string, max: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    const next = current ? `${current} ${word}` : word;
    if (current && next.length > max) {
      lines.push(current);
      current = word;
    } else current = next;
  }
  return current ? [...lines, current] : lines;
}

/** Wrap markdown by its visible length, then style it; bold and code spans stay open across line breaks. */
function wrapMarkdown(text: string, max: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    const next = current ? `${current} ${word}` : word;
    if (current && next.replace(/\*\*|`/g, '').length > max) {
      lines.push(current);
      current = word;
    } else current = next;
  }
  if (current) lines.push(current);
  let isBold = false;
  let isCode = false;
  const reopen = () => (color ? `${isBold ? '\x1b[1m' : ''}${isCode ? '\x1b[36m' : ''}` : '');
  return lines.map((line) => {
    let out = reopen();
    for (const token of line.split(/(\*\*|`)/)) {
      if (token === '**') isBold = !isBold;
      else if (token === '`') isCode = !isCode;
      else {
        out += token;
        continue;
      }
      if (color) out += `\x1b[0m${reopen()}`;
    }
    return color ? `${out}\x1b[0m` : out;
  });
}
