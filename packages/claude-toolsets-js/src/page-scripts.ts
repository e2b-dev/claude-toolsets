/** Host bridge to the generated browser runtime. Arguments are always JSON data. */
import { readFileSync } from 'node:fs';
import {
  REF_BLOCK_SIZE,
  RUNTIME_KEY,
  type Operation,
  type OperationArgs,
  type RuntimeResult,
} from './generated/runtime-contract.ts';

export type { RuntimeResult } from './generated/runtime-contract.ts';

export const runtimeSource = readFileSync(new URL('./generated/runtime.js', import.meta.url), 'utf8');

/** Reserve before transport; never reclaim IDs after a failed or lost response. */
export class ReferenceAllocator {
  private next = 1;
  reserve(): number {
    const base = this.next;
    if (!Number.isSafeInteger(base + REF_BLOCK_SIZE)) {
      throw new Error('Reference limit reached');
    }
    this.next += REF_BLOCK_SIZE;
    return base;
  }
}

export function runtimeExpression<K extends Operation>(operation: K, args: OperationArgs[K]): string {
  const request = JSON.stringify({ operation, args });
  return `globalThis[${JSON.stringify(RUNTIME_KEY)}].call(${request})`;
}

/** Validate the common envelope before either the value or reference counter is used. */
export function runtimeResult<T>(result: unknown): RuntimeResult<T> {
  if (typeof result !== 'object' || result === null) {
    throw new Error('The page did not answer');
  }
  const value = result as Partial<RuntimeResult<T>>;
  if (!Number.isSafeInteger(value.nextRef) || value.nextRef! < 1) {
    throw new Error('Invalid page reference counter');
  }
  if (value.ok === true && Object.hasOwn(value, 'value')) {
    return value as RuntimeResult<T>;
  }
  if (
    value.ok === false &&
    typeof value.error === 'object' &&
    value.error !== null &&
    typeof value.error.code === 'string' &&
    typeof value.error.message === 'string'
  ) {
    return value as RuntimeResult<T>;
  }
  throw new Error('Invalid page result');
}

export function readPageExpr(opts: {
  filter: string | null | undefined;
  depth: number | null | undefined;
  ref: string | null | undefined;
  base: number;
}): string {
  return runtimeExpression('read_page', {
    filter: opts.filter ?? null,
    depth: Math.max(1, Math.min(100, Math.floor(opts.depth ?? 15))),
    ref: opts.ref ?? null,
    cap: 50_000,
    base: opts.base,
  });
}

export const findExpr = (query: string, base: number) => runtimeExpression('find', { query, base });

export const pageTextExpr = (maxChars: number, base: number) =>
  runtimeExpression('page_text', { max: Math.max(1, Math.floor(maxChars)), base });

export const resolvePointExpr = (ref: string, action: 'click' | 'hover', base: number) =>
  runtimeExpression('resolve', { ref, action, base });

export const formInputExpr = (ref: string, value: unknown, base: number) =>
  runtimeExpression('form_input', { ref, value, base });

export const scrollToExpr = (ref: string, base: number) => runtimeExpression('scroll_to', { ref, base });

/** CDP uploads need a node handle, not a JSON value. All staging remains in the host. */
export function fileInputExpr(ref: string, count: number, base: number): string {
  return `${runtimeExpression('file_input', { ref, count, base })}.then(result => result.ok ? result.value : {error: result.error.message})`;
}

/** Recheck the pinned node with the same composed-tree rules after asynchronous staging. */
export function fileInputValidationFunction(ref: string, count: number, base: number): string {
  const request = JSON.stringify({ operation: 'file_input', args: { ref, count, base } });
  return `function(){return globalThis[${JSON.stringify(RUNTIME_KEY)}].call(${request}).then(result => result.ok && result.value === this)}`;
}
