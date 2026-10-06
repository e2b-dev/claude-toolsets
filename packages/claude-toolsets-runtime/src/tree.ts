import { normalizeText, clip, quote } from './text.ts';
import { computedStyle, composedParent, composedChildren, proxyLabel, boxesOf, inViewport } from './dom.ts';
import { roleOf, nameOf, statesOf, INTERACTIVE, NAME_FROM_CONTENT } from './accessibility.ts';
import type { ReferenceStore } from './references.ts';

// An element with no role that still reacts to clicks: onclick, tabindex, or where the pointer cursor starts.
export const clickable = (element: Element, style: CSSStyleDeclaration) => {
  if (/^(LABEL|BODY|HTML)$/.test(element.tagName)) {
    return false;
  }
  if (element.hasAttribute('onclick')) {
    return true;
  }
  const tabIndex = element.getAttribute('tabindex');
  if (tabIndex !== null && Number(tabIndex) >= 0) {
    return true;
  }
  if (style.cursor !== 'pointer') {
    return false;
  }
  const parent = composedParent(element);
  try {
    return !(parent && computedStyle(parent).cursor === 'pointer');
  } catch {
    return true;
  }
};

// The rendered tree: element nodes {el, role, name, states, interactive, boxes, children} and text leaves

// {text, owner, nodes}. Generic wrappers are flattened into their parent; hidden subtrees are dropped.
export const LINE_BREAK = Symbol('line break');

export const build = (source: Node, suppressText: boolean, force: boolean): TreeNode[] => {
  if (source.nodeType === 3) {
    if (suppressText) {
      return [];
    }
    const text = normalizeText(source.textContent);
    return text ? [{ text: text, owner: composedParent(source), nodes: [source] }] : [];
  }
  if (source.nodeType !== 1) {
    return [];
  }
  const element = source as Element;
  const tag = element.tagName;
  if (!force) {
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|HEAD|META|LINK|TITLE|BASE)$/.test(tag)) {
      return [];
    }
    if (element.getAttribute('aria-hidden') === 'true' || element.hasAttribute('inert')) {
      return [];
    }
    if (tag === 'INPUT' && (element as HTMLInputElement).type === 'hidden') {
      return [];
    }
  }
  const style = computedStyle(element);
  let rendered = true;
  try {
    rendered = element.checkVisibility();
  } catch {
    // Older browsers may lack checkVisibility; use the style checks below.
  }
  let proxy = null;
  if (!rendered || style.opacity === '0') {
    if (!rendered && style.display === 'contents') {
      return buildChildren(element, suppressText);
    }
    proxy = proxyLabel(element);
    if (!proxy) {
      return [];
    }
  }
  const role = roleOf(element);
  const click = !role && !proxy && clickable(element, style);
  if (!force && ((!role && !click) || (style.visibility !== 'visible' && !proxy))) {
    return buildChildren(element, suppressText || namesSibling(element));
  }
  const resolvedRole = role || 'generic';
  const name = nameOf(element, resolvedRole);
  const node: ElementNode = {
    element,
    role: resolvedRole,
    name,
    states: statesOf(element, resolvedRole, name),
    children: [],
    inView: false,
    interactive: click || (INTERACTIVE.has(resolvedRole) && tag !== 'OPTION'),
    boxes: boxesOf(proxy || element, element.ownerDocument),
  };
  if (click) {
    node.states.push('clickable');
  }
  node.inView = inViewport(node.boxes);
  if (tag === 'SELECT') {
    const options = [...(element as HTMLSelectElement).options];
    for (const option of options.slice(0, 50)) {
      const os = [];
      if (option.selected) {
        os.push('selected');
      }
      if (
        option.disabled ||
        (option.parentElement &&
          option.parentElement.tagName === 'OPTGROUP' &&
          (option.parentElement as HTMLOptGroupElement).disabled)
      ) {
        os.push('disabled');
      }
      node.children.push({
        element: option,
        role: 'option',
        name: clip(normalizeText(option.label || option.text), 100),
        states: os,
        children: [],
        interactive: false,
        noRef: true,
        boxes: node.boxes,
        inView: node.inView,
      });
    }
    if (options.length > 50) {
      node.children.push({
        text: '(' + (options.length - 50) + ' more options)',
        owner: element,
        nodes: [],
        inView: node.inView,
      });
    }
  } else if (tag === 'IFRAME' || tag === 'FRAME') {
    let frameDocument = null;
    try {
      frameDocument = (element as HTMLIFrameElement).contentDocument;
    } catch {
      // Cross-origin frame contents are omitted.
    }
    if (frameDocument && frameDocument.body) {
      node.children = buildChildren(frameDocument.body, false);
    } else if (!frameDocument) {
      node.states.push('cross-origin');
    }
  } else if (!/^(INPUT|TEXTAREA|IMG|CANVAS|svg)$/i.test(tag)) {
    node.children = buildChildren(
      element,
      suppressText || NAME_FROM_CONTENT.has(resolvedRole) || resolvedRole === 'textbox',
    );
  }
  return [node];
};

// Text that only repeats a name already printed: a control's label, a fieldset legend, a table caption.
export const namesSibling = (element: Element) =>
  (element.tagName === 'LABEL' && !!(element as HTMLLabelElement).control) ||
  element.tagName === 'CAPTION' ||
  (element.tagName === 'LEGEND' && !!element.parentElement && element.parentElement.tagName === 'FIELDSET');

export const buildChildren = (element: Element, suppressText: boolean): TreeNode[] => {
  const list: (TreeNode | typeof LINE_BREAK)[] = [];
  for (const child of composedChildren(element)) {
    const nodes = build(child, suppressText, false);
    if (!nodes.length) {
      continue;
    }
    let block = false;
    if (child.nodeType === 1) {
      try {
        block = !computedStyle(child as Element).display.startsWith('inline');
      } catch {
        // If style lookup fails, keep the existing inline text fallback.
      }
    }
    if (block) {
      list.push(LINE_BREAK);
    }
    list.push(...nodes);
    if (block) {
      list.push(LINE_BREAK);
    }
  }

  // Adjacent text leaves from inline content become one leaf owned by their common parent.
  const output: TreeNode[] = [];
  let previousText: TextNode | null = null;
  for (const entry of list) {
    if (entry === LINE_BREAK) {
      previousText = null;
      continue;
    }
    if (!('text' in entry)) {
      previousText = null;
      output.push(entry);
      continue;
    }
    if (!previousText) {
      previousText = { text: entry.text, owner: entry.owner, nodes: [...entry.nodes] };
      output.push(previousText);
      continue;
    }
    previousText.text += (/^[.,!?;:)\]]/.test(entry.text) ? '' : ' ') + entry.text;
    previousText.nodes.push(...entry.nodes);
    if (previousText.owner !== entry.owner) {
      previousText.owner = element;
    }
  }
  return output;
};

export const textInView = (leaf: TextNode) => {
  if (leaf.inView !== undefined) {
    return leaf.inView;
  }
  for (const source of leaf.nodes) {
    const range = source.ownerDocument!.createRange();
    range.selectNodeContents(source);
    if (inViewport(boxesOf(range, source.ownerDocument!))) {
      return true;
    }
  }
  return false;
};

export const lineOf = (refs: ReferenceStore, source: LineNode) =>
  '- ' +
  source.role +
  (source.name ? ' ' + quote(source.name) : '') +
  (source.noRef ? '' : ' [' + refs.refOf(source.element) + ']') +
  (source.states.length ? ' ' + source.states.join(' ') : '');

export interface LineNode {
  element: Element;
  role: string;
  name: string;
  states: string[];
  noRef?: boolean;
}

export interface ElementNode extends LineNode {
  children: TreeNode[];
  interactive: boolean;
  boxes: import('./dom.ts').Box[];
  inView: boolean;
}

export interface TextNode {
  text: string;
  owner: Element | null;
  nodes: Node[];
  inView?: boolean;
}

export type TreeNode = ElementNode | TextNode;
