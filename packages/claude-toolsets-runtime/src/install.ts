import { RUNTIME_KEY } from './contract.ts';
import { BrowserRuntime } from './dispatch.ts';

// Always evaluated in the adapter's isolated world. Navigation creates a new store.
const scope = globalThis as typeof globalThis & { [RUNTIME_KEY]?: BrowserRuntime };
if (!Object.hasOwn(scope, RUNTIME_KEY)) {
  Object.defineProperty(scope, RUNTIME_KEY, { value: new BrowserRuntime() });
}
