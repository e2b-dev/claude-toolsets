export interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}

export const computedStyle = (element: Element) => element.ownerDocument.defaultView!.getComputedStyle(element);

// Fields whose value is never shown or matched: passwords, and text fields marked as secrets or card data.
export const isSecret = (element: Element) =>
  (element as HTMLInputElement).type === 'password' ||
  /(^|\s)(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp(-month|-year)?)(\s|$)/i.test(
    element.getAttribute('autocomplete') || '',
  );

// Parent in the composed (rendered) tree: slot for slotted nodes, host for shadow root children.
export const composedParent = (node: Node): Element | null => {
  if ((node as Element | Text).assignedSlot) {
    return (node as Element | Text).assignedSlot;
  }
  const parent = node.parentNode;
  if (parent && parent.nodeType === 11) {
    return (parent as ShadowRoot).host || null;
  }
  return parent && parent.nodeType === 1 ? (parent as Element) : null;
};

export const contains = (ancestor: Element, descendant: Element) => {
  for (let node: Element | null = descendant; node; node = composedParent(node)) {
    if (node === ancestor) {
      return true;
    }
  }
  return false;
};

export const closestComposed = (node: Node, matches: (element: Element) => boolean): Element | null => {
  for (let ancestor: Node | null = node; ancestor; ancestor = composedParent(ancestor)) {
    if (ancestor.nodeType === 1 && matches(ancestor as Element)) {
      return ancestor as Element;
    }
  }
  return null;
};

// Children in the composed tree: an open shadow root replaces light children, a slot shows what is assigned to it.
export const composedChildren = (element: Element): Node[] => {
  if (element.shadowRoot) {
    return [...element.shadowRoot.childNodes];
  }
  if (element.tagName === 'SLOT') {
    const assignedNodes = (element as HTMLSlotElement).assignedNodes({ flatten: true });
    return assignedNodes.length ? assignedNodes : [...element.childNodes];
  }
  return [...element.childNodes];
};

// Offset of a (same-origin) frame document's viewport inside the top viewport.
export const frameOffset = (doc: Document) => {
  let x = 0;
  let y = 0;
  let currentWindow: Window | null = doc.defaultView;
  try {
    while (currentWindow && currentWindow.frameElement) {
      const frame: Element = currentWindow.frameElement;
      const rect = frame.getBoundingClientRect();
      x += rect.left + frame.clientLeft;
      y += rect.top + frame.clientTop;
      currentWindow = frame.ownerDocument.defaultView;
    }
  } catch {
    // Cross-origin frame ancestors are inaccessible; retain the known offset.
  }
  return { x, y };
};

export const boxesOf = (target: Element | Range, doc: Document): Box[] => {
  const offset = frameOffset(doc);
  const boxes = [];
  for (const rect of target.getClientRects()) {
    if (rect.width > 0 && rect.height > 0) {
      boxes.push({
        l: rect.left + offset.x,
        t: rect.top + offset.y,
        r: rect.right + offset.x,
        b: rect.bottom + offset.y,
      });
    }
  }
  return boxes;
};

export const inViewport = (boxes: Box[]) =>
  boxes.some((box) => box.r > 0 && box.b > 0 && box.l < innerWidth && box.t < innerHeight);

export const visibleStrict = (element: Element) => {
  try {
    return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  } catch {
    return true;
  }
};

export const isDisabled = (element: Element) =>
  (element.matches && element.matches(':disabled')) ||
  !!closestComposed(element, (element) => element.getAttribute('aria-disabled') === 'true');

export const isInert = (element: Element) => !!closestComposed(element, (element) => element.hasAttribute('inert'));

// A styled checkbox or radio often hides its input behind a visible label, which is what a person clicks.
export const proxyLabel = (element: Element): HTMLLabelElement | null => {
  if (element.tagName !== 'INPUT' || !(element as HTMLInputElement).labels) {
    return null;
  }
  for (const label of (element as HTMLInputElement).labels!) {
    if (visibleStrict(label) && boxesOf(label, label.ownerDocument).length) {
      return label;
    }
  }
  return null;
};

export const needsProxy = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return !visibleStrict(element) || rect.width <= 2 || rect.height <= 2;
};

export const deepActive = (): Element | null => {
  let activeElement = document.activeElement;

  while (activeElement) {
    let nestedActiveElement: Element | null = null;

    try {
      if (activeElement.shadowRoot) {
        nestedActiveElement = activeElement.shadowRoot.activeElement;
      } else if (activeElement.tagName === 'IFRAME') {
        const frameDocument = (activeElement as HTMLIFrameElement).contentDocument;
        nestedActiveElement = frameDocument?.activeElement ?? null;
      }
    } catch {
      // Cross-origin frames cannot expose their focused element.
    }

    if (!nestedActiveElement || nestedActiveElement === activeElement) {
      break;
    }

    activeElement = nestedActiveElement;
  }

  return activeElement;
};

// Yield to page event handlers and release both ports after the turn.
export const tick = () =>
  new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });
