import { ActionError } from '../contract.ts';
import type { OperationArgs } from '../contract.ts';
import type { ReferenceStore } from '../references.ts';
import {
  isInert,
  isDisabled,
  needsProxy,
  proxyLabel,
  visibleStrict,
  contains,
  closestComposed,
  composedParent,
} from '../dom.ts';

export function resolve(refs: ReferenceStore, args: OperationArgs['resolve']) {
  const ref = args.ref;

  const fail = (message: string): never => {
    throw new ActionError('action_failed', ref + ' ' + message);
  };

  const element = refs.lookup(ref);
  if (isInert(element)) {
    return fail('is inert (blocked by a modal or an inactive region); close the dialog first, then read_page again');
  }
  if (args.action === 'click' && isDisabled(element)) {
    return fail('is disabled; it cannot be clicked until the page enables it');
  }
  const label = element.tagName === 'INPUT' && needsProxy(element) ? proxyLabel(element) : null;
  const target = label || element;
  target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  if (!visibleStrict(target)) {
    return fail('is hidden; it may appear after another action (open its menu or section), then read_page again');
  }
  const rects = [...target.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
  if (!rects.length) {
    return fail('has zero size and cannot be clicked; pick a visible element from read_page');
  }

  // Deepest element at a point, through open shadow roots.
  const deepHit = (root: Document | ShadowRoot, x: number, y: number): Element | null => {
    let hitElement = root.elementFromPoint(x, y);
    while (hitElement && hitElement.shadowRoot) {
      const inner = hitElement.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hitElement) {
        break;
      }
      hitElement = inner;
    }
    return hitElement;
  };

  // The hit counts when it is the target or inside it, or the label/control partner of the target.
  const accepts = (hit: Element | null) => {
    if (!hit) {
      return false;
    }
    if (contains(target, hit)) {
      return true;
    }
    const labelAncestor = closestComposed(hit, (ancestor) => ancestor.tagName === 'LABEL');
    if (labelAncestor && (labelAncestor as HTMLLabelElement).control === target) {
      return true;
    }
    if (
      target.tagName === 'LABEL' &&
      (target as HTMLLabelElement).control &&
      contains((target as HTMLLabelElement).control!, hit)
    ) {
      return true;
    }
    return element !== target && contains(element, hit);
  };

  // Hit-tests a point in the target's document, then each enclosing frame up to the top viewport.
  const probe = (x: number, y: number): { outside?: boolean; cover?: Element | null; x?: number; y?: number } => {
    const doc = target.ownerDocument;
    let frameWindow = doc.defaultView!;
    if (x < 0 || y < 0 || x >= frameWindow.innerWidth || y >= frameWindow.innerHeight) {
      return { outside: true };
    }
    const hit = deepHit(doc, x, y);
    if (!accepts(hit)) {
      return { cover: hit };
    }
    let frameX = x;
    let frameY = y;
    while (frameWindow.frameElement) {
      const frameElement = frameWindow.frameElement;
      const rect = frameElement.getBoundingClientRect();
      frameX += rect.left + frameElement.clientLeft;
      frameY += rect.top + frameElement.clientTop;
      const parentWindow = frameElement.ownerDocument.defaultView!;
      if (frameX < 0 || frameY < 0 || frameX >= parentWindow.innerWidth || frameY >= parentWindow.innerHeight) {
        return { outside: true };
      }
      const hitElement = deepHit(frameElement.ownerDocument, frameX, frameY);
      if (hitElement !== frameElement) {
        return { cover: hitElement };
      }
      frameWindow = parentWindow;
    }
    return { x: frameX, y: frameY };
  };

  let cover: Element | null = null;
  for (const rect of rects) {
    for (const [px, py] of [
      [0.5, 0.5],
      [0.25, 0.25],
      [0.75, 0.25],
      [0.25, 0.75],
      [0.75, 0.75],
    ] as const) {
      const result = probe(rect.left + rect.width * px, rect.top + rect.height * py);
      if (result.x !== undefined) {
        return { x: Math.round(result.x * 100) / 100, y: Math.round(result.y! * 100) / 100 };
      }
      if (result.cover && !cover) {
        cover = result.cover;
      }
    }
  }
  if (cover) {
    // Name the outermost element of the cover that does not contain the target, e.g. the whole overlay.
    let coveringElement = cover;
    for (
      let parent = composedParent(coveringElement);
      parent && !/^(BODY|HTML)$/.test(parent.tagName) && !contains(parent, target);
      parent = composedParent(parent)
    ) {
      coveringElement = parent;
    }
    return fail(
      'is covered by another element (' +
        refs.refOf(coveringElement) +
        '); close the overlay or scroll, then read_page again',
    );
  }
  return fail(
    'is outside the visible area and could not be scrolled into view; scroll its container, then read_page again',
  );
}
