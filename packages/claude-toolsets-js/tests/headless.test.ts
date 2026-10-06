import { describe, expect, test } from 'bun:test';
import type { Sandbox } from 'e2b';
import { E2BBrowserToolset } from '../src/index.ts';
import { resolveDisplay } from '../src/sandbox.ts';

const desktop = { display: ':0' }; // what an @e2b/desktop sandbox exposes
const plain = {}; // an e2b sandbox: no screen

describe('where Chrome shows', () => {
  test('visible on a desktop sandbox by default, headless elsewhere', () => {
    expect(resolveDisplay(desktop, undefined, undefined)).toBe(':0');
    expect(resolveDisplay(plain, undefined, undefined)).toBeUndefined();
    expect(resolveDisplay(undefined, undefined, undefined)).toBeUndefined(); // the toolset creates the sandbox
  });
  test('headless forces it either way', () => {
    expect(resolveDisplay(desktop, true, undefined)).toBeUndefined();
    expect(resolveDisplay(desktop, false, undefined)).toBe(':0');
  });
  test('display picks a screen explicitly', () => {
    expect(resolveDisplay(desktop, undefined, ':1')).toBe(':1');
    expect(resolveDisplay(plain, false, ':1')).toBe(':1');
  });
  test('contradictions are refused', () => {
    expect(() => resolveDisplay(desktop, true, ':1')).toThrow('contradict');
    expect(() => resolveDisplay(plain, false, undefined)).toThrow('needs a screen');
  });
  test('create() refuses them before touching the sandbox', async () => {
    const created = E2BBrowserToolset.create({ sandbox: plain as Sandbox, headless: false });
    await expect(created).rejects.toThrow('needs a screen');
  });
});
