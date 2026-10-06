import Fuse from 'fuse.js';
import type { OperationArgs } from '../contract.ts';
import type { ReferenceStore } from '../references.ts';
import { normalizeText, clip } from '../text.ts';
import { buildChildren, lineOf, type TreeNode, type LineNode } from '../tree.ts';
import { isSecret } from '../dom.ts';

/**
 * Plain words people use for each kind of element. They are indexed with every candidate, so "email field" finds an
 * Email textbox and "country dropdown" a Country combobox, though neither word is in the element's name.
 */
const KIND_WORDS: Record<string, string> = {
  button: 'button btn submit',
  link: 'link anchor url',
  textbox: 'input field text box textbox entry',
  searchbox: 'search input field box',
  combobox: 'dropdown select combo combobox picker menu',
  listbox: 'list listbox select multiselect',
  checkbox: 'checkbox check tick toggle box',
  radio: 'radio option choice',
  switch: 'switch toggle',
  heading: 'heading header title headline',
  img: 'image img picture icon logo photo',
  tab: 'tab',
  menuitem: 'menu item',
  slider: 'slider range',
  navigation: 'nav navigation menu',
  dialog: 'dialog modal popup',
  form: 'form',
  table: 'table grid',
  spinbutton: 'number input field',
  option: 'option',
  canvas: 'canvas drawing',
};
const KIND_VOCABULARY = new Set(Object.values(KIND_WORDS).join(' ').split(' '));
const TAG_WORDS: Record<string, string> = {
  textarea: 'text area textarea box',
  select: 'select dropdown',
  img: 'image',
};

/** What the element is, in plain words: its role, tag, input type and autocomplete purpose (`postal-code`). */
function kindOf(element: Element, role: string): string {
  const tag = element.tagName.toLowerCase();
  const type = tag === 'input' ? (element as HTMLInputElement).type : '';
  const purpose = (element.getAttribute('autocomplete') || '').replace(/[-_]/g, ' ');
  return [KIND_WORDS[role] ?? role, TAG_WORDS[tag] ?? '', type, type === 'email' ? 'address' : '', purpose].join(' ');
}

export function find(refs: ReferenceStore, args: OperationArgs['find']) {
  const STOP_WORDS = new Set(
    'the a an to of for on in at with and or that this is it its my me please find element elements show where'.split(
      ' ',
    ),
  );
  const queryWords = normalizeText(args.query).split(/\s+/);
  const meaningfulWords = queryWords.filter((word) => !STOP_WORDS.has(word.toLowerCase()));
  const query = (meaningfulWords.length ? meaningfulWords : queryWords).join(' ');
  if (!query || !document.body) {
    return '';
  }
  type Candidate = LineNode & { interactive: boolean; extra: string; kind: string; inView: boolean };
  const candidates: Candidate[] = [];

  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      if ('text' in node) {
        if (node.owner && node.owner.nodeType === 1) {
          candidates.push({
            element: node.owner,
            role: 'text',
            name: clip(node.text, 100),
            states: [],
            interactive: false,
            extra: '',
            kind: '',
            inView: Boolean(node.inView),
          });
        }
        continue;
      }
      if (!node.noRef && node.boxes.length) {
        const attribute = (attributeName: string) => node.element.getAttribute(attributeName) || '';

        const extra = [
          node.element.tagName.toLowerCase(),
          attribute('placeholder'),
          node.element.tagName === 'INPUT' ? (node.element as HTMLInputElement).type : '',
          attribute('title'),
          attribute('alt'),
          attribute('id'),
          attribute('name'),
          attribute('data-testid'),
          attribute('aria-description'),
          !isSecret(node.element) && typeof (node.element as HTMLInputElement).value === 'string'
            ? (node.element as HTMLInputElement).value
            : '',
        ].join(' ');
        candidates.push({
          element: node.element,
          role: node.role,
          name: node.name,
          states: node.states,
          interactive: node.interactive,
          extra,
          kind: kindOf(node.element, node.role),
          inView: Boolean(node.inView),
        });
      }
      walk(node.children);
    }
  };

  walk(buildChildren(document.body, false));
  // Each word is matched on its own, so a longer description can miss a word or two ("the create account button at
  // the bottom"): at least half must match. One must match the element's own name or attributes, unless the whole
  // query is kind words ("button", "search box").
  const search = new Fuse(candidates, {
    keys: ['name', 'extra', 'kind'],
    includeMatches: true,
    includeScore: true,
    threshold: 0.35,
    ignoreLocation: true,
  });
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const onlyKindWords = words.every((word) => KIND_VOCABULARY.has(word));
  const hits = new Map<Candidate, { words: number; closeness: number; own: boolean }>();
  for (const word of words) {
    for (const result of search.search(word)) {
      const hit = hits.get(result.item) ?? { words: 0, closeness: 0, own: false };
      hit.words += 1;
      hit.closeness += 1 - (result.score ?? 1);
      hit.own ||= (result.matches ?? []).some((match) => match.key === 'name' || match.key === 'extra');
      hits.set(result.item, hit);
    }
  }
  const needed = Math.ceil(words.length / 2);
  const ranked = [...hits]
    .filter(([, hit]) => hit.words >= needed && (hit.own || onlyKindWords))
    .map(([candidate, hit]) => {
      let score = (2 * hit.words) / words.length + hit.closeness / words.length;
      if (candidate.interactive) {
        score += 0.5;
      } // find is mostly asked for something to act on
      if (candidate.inView) {
        score += 0.2;
      }
      if (candidate.role === 'text') {
        score -= 0.3;
      }
      return { candidate, score };
    })
    .sort((first, second) => second.score - first.score);
  const floor = (ranked[0]?.score ?? 0) / 2;
  const matches = [];
  const seenElements = new Set();
  const interactiveNames = new Set();
  for (const { candidate, score } of ranked) {
    if (matches.length >= 20 || score < floor) {
      break;
    }
    if (seenElements.has(candidate.element)) {
      continue;
    }
    if (!candidate.interactive && interactiveNames.has(normalizeText(candidate.name).toLowerCase())) {
      continue;
    }
    seenElements.add(candidate.element);
    if (candidate.interactive) {
      interactiveNames.add(normalizeText(candidate.name).toLowerCase());
    }
    matches.push(candidate);
  }
  return matches.map((node) => lineOf(refs, node)).join('\n');
}
