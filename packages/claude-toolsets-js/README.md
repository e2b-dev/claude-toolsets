# E2B Claude Toolsets for TypeScript

E2B drivers for the browser and computer use toolsets in the Claude TypeScript SDK. `E2BBrowserToolset` runs Chrome on an E2B desktop sandbox; `E2BComputerToolset` drives the whole desktop through screenshots, mouse and keyboard. Pass either one in `tools` and the SDK's tool runner calls it.

```ts
import Anthropic from '@anthropic-ai/sdk';
import { E2BBrowserToolset, allowHosts } from '@e2b/claude-toolsets';

const hosts = ['github.com', 'githubassets.com', 'githubusercontent.com'];
const browser = await E2BBrowserToolset.create({
  allowOut: hosts.flatMap((host) => [host, `*.${host}`]), // what the sandbox can reach (E2B firewall)
  urlPolicy: allowHosts(hosts), // where the model may navigate (SDK check)
});
try {
  const answer = await new Anthropic().beta.messages.toolRunner({
    model: 'claude-sonnet-5-5',
    max_tokens: 1024,
    tools: [browser],
    messages: [{ role: 'user', content: 'How many stars does github.com/e2b-dev/E2B have?' }],
  });
  for (const block of answer.content) if (block.type === 'text') console.log(block.text);
} finally {
  await browser.close();
}
```

Needs `E2B_API_KEY` and `ANTHROPIC_API_KEY`. The [examples](https://github.com/e2b-dev/claude-toolsets/blob/main/examples/README.md) add a live view, computer use and SDK options.
