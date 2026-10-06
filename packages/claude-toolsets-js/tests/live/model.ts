/** LIVE: creates a paid E2B desktop and makes Anthropic calls. Run explicitly. */
import Anthropic from '@anthropic-ai/sdk';
import { Sandbox } from '@e2b/desktop';
import { E2BBrowserToolset, E2BComputerToolset, allowHosts, liveView } from '../../src/index.ts';
import { checkViewer } from './viewer.ts';

const desktop = await Sandbox.create({
  resolution: [1280, 800],
  timeoutMs: 600_000,
  network: { allowPublicTraffic: false, maskRequestHost: 'localhost:${PORT}', denyOut: ['0.0.0.0/0'] },
  metadata: { purpose: 'shared-runtime-live-model-test' },
});
console.log('Created disposable TypeScript test desktop', desktop.sandboxId);
try {
  await desktop.files.makeDir('/tmp/runtime-model-fixture');
  await desktop.files.write(
    '/tmp/runtime-model-fixture/index.html',
    `<!doctype html><title>Runtime verification</title>
    <label>Message <input id="message"></label>
    <button onclick="document.querySelector('output').textContent='Verified: '+document.querySelector('input').value">Verify</button>
    <output></output>`,
  );
  const server = await desktop.commands.run(
    'python3 -m http.server 8000 --bind 127.0.0.1 --directory /tmp/runtime-model-fixture',
    { background: true },
  );
  await server.disconnect();
  await desktop.commands.run(
    'for i in $(seq 1 50); do curl -fsS http://127.0.0.1:8000 >/dev/null && exit 0; sleep 0.1; done; exit 1',
  );
  const view = await liveView(desktop);
  try {
    await checkViewer(view.url);
    const client = new Anthropic();
    const model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5';
    const browser = await E2BBrowserToolset.create({
      sandbox: desktop,
      display: ':0',
      urlPolicy: allowHosts(['localhost:8000']),
    });
    try {
      const original = browser.run.bind(browser);
      const called = new Set<string>();
      browser.run = async (...args) => {
        called.add(args[1].name);
        console.log('browser tool', args[1].name);
        return original(...args);
      };
      await client.beta.messages.toolRunner({
        model,
        max_tokens: 1024,
        max_iterations: 15,
        tools: [browser],
        messages: [
          {
            role: 'user',
            content:
              'Test this disposable browser. Navigate to http://localhost:8000. Use read_page and find to locate Message. Use form_input with its element reference to set it to BROWSER_OK, then click Verify using its reference. Read the resulting page text and take a screenshot. Stop after verifying it says Verified: BROWSER_OK. Do not visit any other website.',
          },
        ],
      });
      const result = await browser.toolResult({
        type: 'tool_use',
        id: 'verify',
        toolset_name: 'browser',
        name: 'get_page_text',
        input: {},
      });
      if (result.is_error || !JSON.stringify(result.content).includes('Verified: BROWSER_OK'))
        throw new Error('Browser model did not complete the fixture');
      for (const name of ['read_page', 'find', 'form_input', 'left_click', 'screenshot'])
        if (!called.has(name)) throw new Error(`Model did not exercise ${name}`);
      console.log('PASS TypeScript model browser task verified from actual page state');
    } finally {
      await browser.close();
    }
    const computer = await E2BComputerToolset.create(desktop, { confirm: () => true });
    try {
      const original = computer.run.bind(computer);
      const called = new Set<string>();
      computer.run = async (...args) => {
        called.add(args[1].name);
        console.log('computer tool', args[1].name);
        return original(...args);
      };
      await client.beta.messages.toolRunner({
        model,
        max_tokens: 1024,
        max_iterations: 15,
        tools: [computer],
        messages: [
          {
            role: 'user',
            content:
              'Test this disposable desktop using the computer tools. Take a screenshot, open a terminal (Ctrl+Alt+t should work), and type and execute: printf COMPUTER_OK > /tmp/runtime-computer-check.txt . Take another screenshot and stop. This file is the sole task; do not access the network.',
          },
        ],
      });
      const result = await desktop.commands.run('cat /tmp/runtime-computer-check.txt');
      if (result.stdout.trim() !== 'COMPUTER_OK') throw new Error('Computer model did not write the expected file');
      for (const name of ['screenshot', 'type', 'key'])
        if (!called.has(name)) throw new Error(`Model did not exercise ${name}`);
      console.log('PASS TypeScript model computer task verified from sandbox file');
    } finally {
      await computer.close();
    }
  } finally {
    await view.stop();
  }
} finally {
  await desktop.kill();
  console.log('TypeScript test desktop cleanup completed');
}
