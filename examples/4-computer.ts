/**
 * 4. Computer use: Claude works a whole desktop, not just a browser, and you watch it live.
 *
 *   pnpm example:computer
 *   pnpm example:computer "Open LibreOffice Calc and enter an expense report with a SUM total"
 *
 * The computer toolset gets screenshots and mouse/keyboard actions instead of browser tools, so it can use any app.
 * This one works the desktop like a person: a terminal to create a folder on the Desktop and clone E2B's infra repo
 * into it, then the file manager to show it.
 *
 * Needs ANTHROPIC_API_KEY and E2B_API_KEY. `tui.*` only prints; remove those calls and this is plain package usage.
 */
import Anthropic from '@anthropic-ai/sdk';
import { Sandbox } from '@e2b/desktop';
import { E2BComputerToolset, liveView } from '@e2b/claude-toolsets';
import * as tui from './tui.ts';

const task =
  process.argv.slice(2).join(' ') ||
  'Open a terminal, create a folder called e2b on the Desktop, and clone https://github.com/e2b-dev/infra into it with --depth 1. Then open that folder in the file manager and tell me the top-level folders of the repo.';

const desktop = await Sandbox.create({
  resolution: [1280, 800], // screenshots are sent at this size, which fits the model's image limits
  timeoutMs: 600_000,
  network: {
    allowPublicTraffic: false, // keeps the desktop stream private
    allowOut: ['github.com', '*.github.com', '*.githubusercontent.com'], // only GitHub, for the clone
    denyOut: ['0.0.0.0/0'],
  },
});
const view = await liveView(desktop).catch(async (error) => {
  await desktop.kill();
  throw error;
});
try {
  const computer = await E2BComputerToolset.create(desktop, {
    confirm: () => true, // required for key, type and hold_key: approve every call (unattended). An app could ask a person here.
  });
  try {
    const answer = await new Anthropic().beta.messages.toolRunner({
      model: 'claude-sonnet-5-5',
      max_tokens: 4096,
      tools: [tui.trace(computer, { Task: task, Watch: view.url, Sandbox: desktop.sandboxId })],
      messages: [{ role: 'user', content: task }],
    });
    tui.done(answer);
  } finally {
    await computer.close(); // leaves the desktop running; the finally below kills it
  }
  await tui.holdOpen('close the desktop');
} finally {
  await view.stop();
  await desktop.kill();
}
