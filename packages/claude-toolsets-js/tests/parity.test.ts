import { describe, expect, test } from 'bun:test';
import { BrowserSandboxError, E2BBrowserToolset, allowHosts } from '../src/index.ts';
import { checkScreen, pngSize } from '../src/screen.ts';
import { localRefusal } from '../src/policy.ts';

const ctx = { tabId: 'tab_1' } as never;
const allows = (policy: ReturnType<typeof allowHosts>, url: string) => {
  try {
    return policy(ctx, url) === undefined;
  } catch {
    return false;
  }
};

describe('allowHosts', () => {
  test('a host includes its subdomains; a port is kept as written', () => {
    const policy = allowHosts(['github.com', 'localhost:8000', 'example.com:443']);
    expect(allows(policy, 'https://docs.github.com/x')).toBe(true);
    expect(allows(policy, 'http://localhost:8000/')).toBe(true);
    expect(allows(policy, 'http://localhost:9000/')).toBe(false);
    expect(allows(policy, 'https://example.com/')).toBe(true);
    expect(allows(policy, 'https://example.com:8443/')).toBe(false); // :443 is not "any port"
  });
  test('malformed entries are refused, as in Python', () => {
    for (const entry of ['', 'https://github.com', 'github.com/path', 'user@github.com', 'github.com?q'])
      expect(() => allowHosts([entry])).toThrow('is not a hostname');
  });
});

describe('screen size', () => {
  test('at most 2560x1440 pixels in total, at least 200 a side', () => {
    expect(() => checkScreen('viewport', 2560, 1440)).not.toThrow();
    expect(() => checkScreen('viewport', 1920, 1200)).not.toThrow();
    expect(() => checkScreen('viewport', 2560, 1600)).toThrow('too large');
    expect(() => checkScreen('viewport', 3840, 2160)).toThrow('too large');
    expect(() => checkScreen('viewport', 100, 800)).toThrow('at least 200');
  });
  test('create() refuses an oversized viewport before anything starts', async () => {
    await expect(E2BBrowserToolset.create({ viewport: { width: 3840, height: 2160 } })).rejects.toThrow('too large');
  });
  test('pngSize reads the header', () => {
    const png = new Uint8Array(24);
    new DataView(png.buffer).setUint32(16, 1280);
    new DataView(png.buffer).setUint32(20, 800);
    expect(pngSize(png)).toEqual({ width: 1280, height: 800 });
  });
});

test('BrowserSandboxError is exported', async () => {
  const error = await E2BBrowserToolset.create({ sandbox: {} as never, headless: false }).catch((e) => e);
  expect(error).toBeInstanceOf(BrowserSandboxError);
});

describe('localRefusal', () => {
  test("refuses the sandbox's DevTools, envd and noVNC ports on every local address, like the Python driver", () => {
    for (const url of [
      'http://localhost:9222/json',
      'http://2130706433:49983/',
      'http://[::ffff:127.0.0.1]:6080/vnc.html',
      'ws://127.0.0.1:6080/websockify',
    ])
      expect(localRefusal(url)).toBe('refused');
    expect(localRefusal('http://localhost:8000/')).toBe('local');
    expect(localRefusal('https://example.com:6080/')).toBe('public');
  });
});
