import type { OperationArgs } from '../contract.ts';
import type { ReferenceStore } from '../references.ts';
import { needsProxy, proxyLabel } from '../dom.ts';

export function scrollTo(refs: ReferenceStore, args: OperationArgs['scroll_to']) {
  const element = refs.lookup(args.ref);
  const target = (element.tagName === 'INPUT' && needsProxy(element) && proxyLabel(element)) || element;
  target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  return null;
}
