/** Internal plain-data contract. No SDK, transport, or sandbox dependencies. */
export const RUNTIME_VERSION = '0.3.0';

export const RUNTIME_KEY = '__e2bBrowserRuntime_0_3_0';

// Hosts reserve a disjoint block before sending a request; lost replies cannot reuse IDs.
export const REF_BLOCK_SIZE = 1_000_000;

export interface OperationArgs {
  read_page: { filter: string | null; depth: number; ref: string | null; cap: number; base: number };
  find: { query: string; base: number };
  page_text: { max: number; base: number };
  resolve: { ref: string; action: 'click' | 'hover'; base: number };
  form_input: { ref: string; value: unknown; base: number };
  scroll_to: { ref: string; base: number };
  file_input: { ref: string; count: number; base: number };
}

export interface OperationValues {
  read_page: string;
  find: string;
  page_text: string;
  resolve: { x: number; y: number };
  form_input: { summary: string };
  scroll_to: null;
  // Transport exception: resolved by remote object, never serialized by value.
  file_input: unknown;
}

export type Operation = keyof OperationArgs;

export type RuntimeRequest = { [K in Operation]: { operation: K; args: OperationArgs[K] } }[Operation];

export type ErrorCode = 'invalid_ref' | 'stale_ref' | 'action_failed' | 'script_failed' | 'unsupported';

export type RuntimeResult<T> =
  | { ok: true; value: T; nextRef: number }
  | { ok: false; error: { code: ErrorCode; message: string }; nextRef: number };

export class ActionError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
