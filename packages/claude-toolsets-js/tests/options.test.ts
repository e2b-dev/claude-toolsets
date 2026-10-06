import { describe, expect, test } from 'bun:test';
import type { Sandbox } from 'e2b';
import { E2BBrowserToolset } from '../src/index.ts';

// Refused before the sandbox is touched, so a stand-in object is enough.
const sandbox = {} as Sandbox;

describe('attaching to your own sandbox', () => {
  test.each([
    ['template', { template: 'desktop' }],
    ['timeoutMs', { timeoutMs: 60_000 }],
    ['metadata', { metadata: { purpose: 'x' } }],
    ['apiKey', { apiKey: 'e2b_x' }],
    ['allowOut', { allowOut: ['example.com'] }],
  ])('refuses %s, which only applies to a sandbox the toolset creates', async (name, extra) => {
    // @ts-expect-error the option types refuse it as well
    const created = E2BBrowserToolset.create({ sandbox, ...extra });
    await expect(created).rejects.toThrow(`${name} applies only to a sandbox this call creates`);
  });

  test('names every refused option at once', async () => {
    // @ts-expect-error
    const created = E2BBrowserToolset.create({ sandbox, template: 'desktop', timeoutMs: 1 });
    await expect(created).rejects.toThrow('template, timeoutMs apply only to a sandbox this call creates');
  });
});
