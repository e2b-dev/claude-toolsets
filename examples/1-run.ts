/**
 * 1. Hello world: Claude drives Chrome on an E2B desktop sandbox, and you watch it live.
 *
 *   pnpm example                                                      # default: E2B's GitHub stars + latest release
 *   pnpm example "Find the most starred repo in github.com/e2b-dev"   # the whole command line is the task
 *
 * Same shape as Anthropic's browser-toolset quickstart (run.ts): build the driver, pass it in `tools`, run the tool
 * runner, close it. The difference: the browser runs on a private E2B desktop instead of your machine, and `liveView`
 * streams that desktop to a local URL so you can watch.
 *
 * Needs ANTHROPIC_API_KEY and E2B_API_KEY (in .env). In this repo the workspace links `@e2b/claude-toolsets` to
 * packages/claude-toolsets-js, so the import reads exactly as it does with the published package.
 * `tui.*` only prints; remove those calls and this is plain package usage.
 */
import Anthropic from '@anthropic-ai/sdk';
import { Sandbox } from '@e2b/desktop';
import { E2BBrowserToolset, allowHosts, liveView } from '@e2b/claude-toolsets';
import * as tui from './tui.ts';

const task =
  process.argv.slice(2).join(' ') ||
  'Go to github.com/e2b-dev/E2B, tell me how many stars the repo has, then open its releases and summarize the latest release in three bullets.';
// GitHub serves its CSS, scripts and images from githubassets.com and githubusercontent.com.
const domains = ['github.com', 'githubassets.com', 'githubusercontent.com'];

const desktop = await Sandbox.create({
  resolution: [1280, 800],
  network: {
    allowPublicTraffic: false, // required: keeps Chrome's DevTools port and the desktop stream private
    maskRequestHost: 'localhost:${PORT}',
    allowOut: domains.flatMap((d) => [d, `*.${d}`]), // the sandbox can reach only these hosts (enforced by E2B)
    denyOut: ['0.0.0.0/0'],
  },
});
const view = await liveView(desktop).catch(async (error) => {
  await desktop.kill();
  throw error;
});
try {
  const browser = await E2BBrowserToolset.create({
    sandbox: desktop,
    urlPolicy: allowHosts(domains), // the model may only navigate to these hosts (enforced by the SDK)
  });
  try {
    const answer = await new Anthropic().beta.messages.toolRunner({
      model: 'claude-sonnet-5-5',
      max_tokens: 1024,
      tools: [tui.trace(browser, { Task: task, Watch: view.url, Sandbox: desktop.sandboxId })],
      messages: [{ role: 'user', content: task }],
    });
    tui.done(answer);
  } finally {
    await browser.close(); // the tool runner never closes a toolset; you do
  }
  await tui.holdOpen('close the desktop');
} finally {
  await view.stop();
  await desktop.kill();
}
