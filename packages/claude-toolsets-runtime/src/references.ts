import { ActionError, REF_BLOCK_SIZE } from './contract.ts';
import { clip, quote } from './text.ts';

/** One store per isolated context/document; the host reserves a disjoint block for each request. */
export class ReferenceStore {
  next = 1;
  private limit = 1;
  private readonly byRef = new Map<string, Element>();
  private readonly byElement = new WeakMap<Element, string>();

  advance(base: number): void {
    if (!Number.isSafeInteger(base) || base < 1 || !Number.isSafeInteger(base + REF_BLOCK_SIZE)) {
      throw new ActionError('action_failed', 'Invalid reference base');
    }
    this.next = Math.max(this.next, base);
    // A delayed older request must not rewind the currently usable block.
    this.limit = Math.max(this.limit, base + REF_BLOCK_SIZE);
  }

  refOf(element: Element): string {
    let ref = this.byElement.get(element);
    if (!ref) {
      if (this.next >= this.limit) {
        throw new ActionError('action_failed', 'Reference allocation limit reached; narrow the page query');
      }
      ref = 'ref_' + this.next++;
      this.byElement.set(element, ref);
      this.byRef.set(ref, element);
    }
    return ref;
  }

  lookup(ref: string): Element {
    if (typeof ref !== 'string' || !/^ref_\d+$/.test(ref)) {
      throw new ActionError(
        'invalid_ref',
        'Invalid ref ' + quote(clip(String(ref), 40)) + '; use a ref like ref_7 from read_page or find',
      );
    }
    const element = this.byRef.get(ref);
    if (!element) {
      throw new ActionError(
        'stale_ref',
        ref + ' is not a known element on this page; call read_page or find again for fresh refs',
      );
    }
    if (!element.isConnected || !element.ownerDocument.defaultView) {
      throw new ActionError('stale_ref', ref + ' is no longer on the page; call read_page again for fresh refs');
    }
    return element;
  }
}
