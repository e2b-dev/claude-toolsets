/** Run in a separate process so mocking fs cannot affect other tests. */
import { mock } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const fs = { ...(await import('node:fs/promises')) };
const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'growing-upload-')));
const path = join(root, 'approved.bin');
await fs.writeFile(path, new Uint8Array([1]));
mock.module('node:fs/promises', () => ({
  ...fs,
  open: async (...args: Parameters<typeof fs.open>) => {
    await fs.writeFile(path, new Uint8Array(10 * 1024 * 1024 + 1));
    return fs.open(...args);
  },
}));
try {
  const { prepareUploads } = await import('../../src/uploads.ts');
  try {
    await prepareUploads([path], [], new Map());
    throw new Error('Growing upload was accepted');
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('total size exceeds 10 MiB')) throw error;
  }
} finally {
  mock.restore();
  await fs.rm(root, { recursive: true, force: true });
}
