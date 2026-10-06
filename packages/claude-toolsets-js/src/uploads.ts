/** Read only SDK-policy-approved local files, bounded before they cross into the sandbox. */
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { ToolError } from '@anthropic-ai/sdk/helpers/beta/toolsets';

export interface UploadFile {
  name: string;
  data: Uint8Array;
}

/** Application-staged documents, addressed by IDs already vetted by the SDK's file policy. */
export type UploadDocuments = ReadonlyMap<string, UploadFile>;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 20;

export function uploadName(name: string): string {
  if (!name || name === '.' || name === '..' || /[\\/\x00-\x1f\x7f]/.test(name) || Buffer.byteLength(name) > 255)
    throw new ToolError('file_upload: invalid file name');
  return name;
}

export async function readUpload(path: string, budget: number, signal?: AbortSignal | null): Promise<UploadFile> {
  signal?.throwIfAborted();
  if (!isAbsolute(path) || path.includes('\0'))
    throw new ToolError('file_upload: expected a policy-resolved absolute path');
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(path);
    if (!before.isFile() || (await realpath(path)) !== path)
      throw new ToolError('file_upload: source must be a resolved regular file');
    if (before.size > budget) throw new ToolError('file_upload: total size exceeds 10 MiB');
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (opened.size > budget) throw new ToolError('file_upload: total size exceeds 10 MiB');
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs
    )
      throw new ToolError('file_upload: source changed while opening');
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs)
      throw new ToolError('file_upload: source changed while reading');
    if ((await realpath(path)) !== path) throw new ToolError('file_upload: source changed while reading');
    return { name: uploadName(basename(path)), data: buffer.subarray(0, length) };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ToolError) throw error;
    // Filesystem errors contain private paths; only the application may see those.
    throw new ToolError('file_upload: could not read the approved file');
  } finally {
    await handle?.close();
  }
}

export async function prepareUploads(
  paths: string[],
  documentIds: string[],
  documents: UploadDocuments,
  signal?: AbortSignal | null,
): Promise<UploadFile[]> {
  const count = paths.length + documentIds.length;
  if (!count || count > MAX_UPLOAD_FILES) throw new ToolError('file_upload: provide between 1 and 20 files');
  const files: UploadFile[] = [];
  let remaining = MAX_UPLOAD_BYTES;
  for (const path of paths) {
    const file = await readUpload(path, remaining, signal);
    remaining -= file.data.byteLength;
    files.push(file);
  }
  for (const id of documentIds) {
    signal?.throwIfAborted();
    const file = documents.get(id);
    if (!file) throw new ToolError('file_upload: document has not been staged by the application');
    if (file.data.byteLength > remaining) throw new ToolError('file_upload: total size exceeds 10 MiB');
    remaining -= file.data.byteLength;
    files.push({ name: uploadName(file.name), data: new Uint8Array(file.data) });
  }
  return files;
}
