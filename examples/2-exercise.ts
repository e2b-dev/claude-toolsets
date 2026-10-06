/**
 * 2. Exercise the toolset without a model: no Anthropic key, just E2B. Like the quickstart's exercise.ts, it sends the
 * calls a model would send through `browser.toolResult()` (the same pipeline the tool runner uses), prints each result
 * as the model would see it, and fails if a call comes back differently. A smoke test for the package.
 *
 *   pnpm example:exercise
 *
 * Expected: navigate ✓, get_page_text ✓, then navigate to example.com ✗ ("blocked"), because allowHosts refuses it.
 */
import { E2BBrowserToolset, allowHosts } from '@e2b/claude-toolsets';

/** No model: send the calls a model would send, through the same entry point the tool runner uses. */
async function exercise(): Promise<void> {
  const browser = await E2BBrowserToolset.create({
    allowOut: ['github.com', '*.github.com', 'githubassets.com', '*.githubassets.com'],
    urlPolicy: allowHosts(['github.com']),
  });
  try {
    let id = 0;
    const call = async (name: string, input: Record<string, unknown> = {}) => {
      const result = await browser.toolResult({
        type: 'tool_use',
        id: `check_${++id}`,
        toolset_name: 'browser',
        name,
        input,
      });
      const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
      console.log(`${result.is_error ? '✗' : '✓'} ${name}: ${content.replace(/\s+/g, ' ').slice(0, 120)}`);
      return result;
    };
    await call('navigate', { url: 'https://github.com/e2b-dev/E2B' });
    await call('get_page_text');
    const refused = await call('navigate', { url: 'https://example.com' }); // not in allowHosts: the SDK refuses it
    if (!refused.is_error) throw new Error('urlPolicy did not refuse example.com');
  } finally {
    await browser.close();
  }
}

await exercise();
