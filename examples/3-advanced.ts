/**
 * 3. Beyond hello world: SDK options pass through unchanged. Enables javascript_exec, which is off by default because
 * the model can run any script on the page. The SDK refuses to enable it without a `confirm` hook; programmatic code
 * that runs unattended passes one that approves every call.
 *
 *   pnpm example:advanced
 *
 * Needs ANTHROPIC_API_KEY and E2B_API_KEY. `tui.trace` and `tui.done` only print; remove them and this is plain
 * package usage.
 */
import Anthropic from '@anthropic-ai/sdk';
import { E2BBrowserToolset, allowHosts } from '@e2b/claude-toolsets';
import * as tui from './tui.ts';

const task =
  'Open github.com/e2b-dev/E2B, then use javascript_exec to list the top-level files and folders shown in the repo. Reply with the list.';

const browser = await E2BBrowserToolset.create({
  allowOut: ['github.com', '*.github.com', 'githubassets.com', '*.githubassets.com'],
  urlPolicy: allowHosts(['github.com']),
  configs: { javascript_exec: { enabled: true } }, // off by default: the model could run any script on the page
  confirm: () => true, // required with javascript_exec: approve every call (unattended). An app could ask a person here.
});
try {
  const answer = await new Anthropic().beta.messages.toolRunner({
    model: 'claude-sonnet-5-5',
    max_tokens: 1024,
    tools: [tui.trace(browser, { Task: task, Sandbox: browser.sandbox.sandboxId })],
    messages: [{ role: 'user', content: task }],
  });
  tui.done(answer);
} finally {
  await browser.close();
}
