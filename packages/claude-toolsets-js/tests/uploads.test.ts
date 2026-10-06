import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, symlink, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_UPLOAD_BYTES, prepareUploads, readUpload, uploadName } from '../src/uploads.ts';

test('growth between policy-approved metadata and opening cannot bypass the upload budget', () => {
  const result = Bun.spawnSync([process.execPath, new URL('./fixtures/growing-upload.ts', import.meta.url).pathname]);
  expect(result.exitCode).toBe(0);
});

test('local uploads preserve binary bytes and reject directories and symlinks', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'upload-unit-')));
  try {
    const file = join(root, 'binary.dat');
    await writeFile(file, new Uint8Array([0, 255, 1, 128]));
    const upload = await readUpload(file, MAX_UPLOAD_BYTES);
    expect(upload.name).toBe('binary.dat');
    expect(Array.from(upload.data)).toEqual([0, 255, 1, 128]);
    await symlink(file, join(root, 'link.dat'));
    await expect(readUpload(join(root, 'link.dat'), MAX_UPLOAD_BYTES)).rejects.toThrow('regular file');
    await expect(readUpload(root, MAX_UPLOAD_BYTES)).rejects.toThrow('regular file');
    await mkdir(join(root, 'directory'));
    await symlink(root, join(root, 'directory-link'));
    await expect(readUpload(join(root, 'directory-link', 'binary.dat'), MAX_UPLOAD_BYTES)).rejects.toThrow(
      'resolved regular file',
    );
    await expect(readUpload(file, 3)).rejects.toThrow('10 MiB');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing sources are refused without disclosing private paths', async () => {
  await expect(readUpload('/private/nonexistent/secret.txt', MAX_UPLOAD_BYTES)).rejects.toThrow(
    'could not read the approved file',
  );
});

test('documents are bounded in aggregate, have safe names, and copy application bytes', async () => {
  const bytes = new Uint8Array([1, 2]);
  const documents = new Map([
    ['one', { name: 'same.txt', data: bytes }],
    ['two', { name: 'same.txt', data: bytes }],
  ]);
  const files = await prepareUploads([], ['one', 'two'], documents);
  bytes[0] = 3;
  expect(Array.from(files[0]!.data)).toEqual([1, 2]);
  expect(files[1]!.name).toBe('same.txt');
  await expect(prepareUploads([], ['unknown'], documents)).rejects.toThrow('not been staged');
  await expect(prepareUploads([], [], documents)).rejects.toThrow('1 and 20');
  await expect(prepareUploads([], Array(21).fill('one') as string[], documents)).rejects.toThrow('1 and 20');
  const large = new Map([['large', { name: 'large.bin', data: new Uint8Array(MAX_UPLOAD_BYTES) }]]);
  await expect(prepareUploads([], ['large', 'large'], large)).rejects.toThrow('10 MiB');
  for (const name of ['../secret', 'a/b', 'a\\b', '.', '..', 'secret\nname', ''])
    expect(() => uploadName(name)).toThrow('file name');
});

test('aborted staging stops before reading a file', async () => {
  await expect(readUpload('/private/nonexistent.txt', MAX_UPLOAD_BYTES, AbortSignal.abort())).rejects.toThrow();
});
