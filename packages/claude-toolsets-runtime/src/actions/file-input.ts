import { ActionError, type OperationArgs } from '../contract.ts';
import { isDisabled, isInert } from '../dom.ts';
import type { ReferenceStore } from '../references.ts';

/** The host pins this node via CDP before staging any upload bytes. */
export function fileInput(refs: ReferenceStore, args: OperationArgs['file_input']): HTMLInputElement {
  const element = refs.lookup(args.ref);
  if (element.tagName !== 'INPUT' || (element as HTMLInputElement).type !== 'file') {
    throw new ActionError('action_failed', 'target must be a file input');
  }
  const input = element as HTMLInputElement;
  if (isDisabled(input) || isInert(input)) {
    throw new ActionError('action_failed', 'file input is disabled or inert');
  }
  if (!input.multiple && args.count > 1) {
    throw new ActionError('action_failed', 'file input does not allow multiple files');
  }
  return input;
}
