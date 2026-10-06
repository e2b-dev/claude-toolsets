import { normalizeText, clip, quote } from './text.ts';
import {
  computedStyle,
  composedParent,
  closestComposed,
  composedChildren,
  isSecret,
  isDisabled,
  deepActive,
} from './dom.ts';

export const ARIA = new Set(
  (
    'alert alertdialog application article banner blockquote button cell checkbox columnheader combobox ' +
    'complementary contentinfo dialog document feed figure form grid gridcell group heading img link list listbox listitem ' +
    'log main math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation note option progressbar radio ' +
    'radiogroup region row rowheader scrollbar search searchbox separator slider spinbutton status switch tab table tablist ' +
    'tabpanel textbox timer toolbar tooltip tree treegrid treeitem'
  ).split(' '),
);

export const TAG_ROLE: Record<string, string> = {
  NAV: 'navigation',
  MAIN: 'main',
  ASIDE: 'complementary',
  FORM: 'form',
  DIALOG: 'dialog',
  ARTICLE: 'article',
  UL: 'list',
  OL: 'list',
  MENU: 'list',
  LI: 'listitem',
  TABLE: 'table',
  TR: 'row',
  TD: 'cell',
  FIELDSET: 'group',
  DETAILS: 'group',
  OPTGROUP: 'group',
  OPTION: 'option',
  HR: 'separator',
  PROGRESS: 'progressbar',
  METER: 'meter',
  TEXTAREA: 'textbox',
  BUTTON: 'button',
  SUMMARY: 'button',
  IFRAME: 'iframe',
  FRAME: 'iframe',
  CANVAS: 'canvas',
  FIGURE: 'figure',
  BLOCKQUOTE: 'blockquote',
  SEARCH: 'search',
};

export const INPUT_ROLE: Record<string, string> = {
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  number: 'spinbutton',
  search: 'searchbox',
  button: 'button',
  submit: 'button',
  reset: 'button',
  image: 'button',
  file: 'button',
  color: 'button',
};

// Roles whose accessible name is their text content; their own text is not repeated as text leaves.
export const NAME_FROM_CONTENT = new Set([
  'button',
  'link',
  'heading',
  'option',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'treeitem',
  'cell',
  'gridcell',
  'columnheader',
  'rowheader',
  'switch',
  'checkbox',
  'radio',
  'tooltip',
  'generic',
]);

export const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'spinbutton',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'switch',
  'slider',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'treeitem',
]);

// Containers kept as context around actionable elements in the "interactive" view.
export const CONTEXT = new Set([
  'main',
  'navigation',
  'form',
  'dialog',
  'alertdialog',
  'banner',
  'contentinfo',
  'complementary',
  'region',
  'search',
  'menu',
  'menubar',
  'listbox',
  'tablist',
  'radiogroup',
  'group',
  'toolbar',
  'tree',
  'grid',
  'iframe',
]);

export const TEXT_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'slider', 'combobox']);

export const roleOf = (element: Element): string | null => {
  const explicitRole = (element.getAttribute('role') || '').trim().toLowerCase().split(/\s+/)[0];
  if (explicitRole === 'none' || explicitRole === 'presentation') {
    return null;
  }
  if (explicitRole && ARIA.has(explicitRole)) {
    return explicitRole;
  }
  const tag = element.tagName;
  if (tag === 'A' || tag === 'AREA') {
    return element.hasAttribute('href') ? 'link' : null;
  }
  if (tag === 'INPUT') {
    const inputType = (element as HTMLInputElement).type;
    if (inputType === 'hidden') {
      return null;
    }
    return INPUT_ROLE[inputType] || (element.hasAttribute('list') ? 'combobox' : 'textbox');
  }
  if (tag === 'SELECT') {
    return (element as HTMLSelectElement).multiple || (element as HTMLSelectElement).size > 1 ? 'listbox' : 'combobox';
  }
  if (/^H[1-6]$/.test(tag)) {
    return 'heading';
  }
  if (tag === 'IMG') {
    return element.getAttribute('alt') === '' ? null : 'img';
  }
  if (tag.toLowerCase() === 'svg') {
    return element.getAttribute('aria-label') || element.querySelector('title') ? 'img' : null;
  }
  if (tag === 'HEADER' || tag === 'FOOTER') {
    const parent = composedParent(element);
    if (parent && closestComposed(parent, (ancestor) => /^(ARTICLE|ASIDE|MAIN|NAV|SECTION)$/.test(ancestor.tagName))) {
      return null;
    }
    return tag === 'HEADER' ? 'banner' : 'contentinfo';
  }
  if (tag === 'SECTION') {
    return element.hasAttribute('aria-label') || element.hasAttribute('aria-labelledby') ? 'region' : null;
  }
  if (tag === 'TH') {
    return element.getAttribute('scope') === 'row' ? 'rowheader' : 'columnheader';
  }
  if ((element as HTMLElement).isContentEditable) {
    const parent = composedParent(element);
    if (!(parent && (parent as HTMLElement).isContentEditable)) {
      return 'textbox';
    }
  }
  return TAG_ROLE[tag] || null;
};

// Visible text of a subtree for naming, with inline children joined tight and blocks spaced.
export const textOf = (element: Element, includeHidden: boolean, depth: number): string => {
  if (depth > 25) {
    return '';
  }
  let text = '';
  for (const child of composedChildren(element)) {
    const childElement = child as Element;
    if (childElement.nodeType === 3) {
      text += childElement.textContent;
      continue;
    }
    if (childElement.nodeType !== 1) {
      continue;
    }
    const tag = childElement.tagName;
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|INPUT|SELECT|TEXTAREA)$/.test(tag)) {
      continue;
    }
    if (!includeHidden) {
      if (childElement.getAttribute('aria-hidden') === 'true') {
        continue;
      }
      try {
        if (!childElement.checkVisibility() && computedStyle(childElement).display !== 'contents') {
          continue;
        }
      } catch {
        // Some DOM implementations cannot report style; retain the text fallback.
      }
    }
    const ariaLabel = childElement.getAttribute('aria-label');
    let part: string;
    if (ariaLabel) {
      part = ariaLabel;
    } else if (tag === 'IMG') {
      part = childElement.getAttribute('alt') || '';
    } else {
      part = textOf(childElement, includeHidden, depth + 1);
    }
    text += computedStyle(childElement).display.startsWith('inline') ? part : ' ' + part + ' ';
  }
  return text;
};

export const contentName = (element: Element, includeHidden: boolean) =>
  clip(normalizeText(textOf(element, includeHidden, 0)), 150);

export const nameOf = (element: Element, role: string): string => {
  const tag = element.tagName;

  const attr = (attributeName: string) => element.getAttribute(attributeName);

  const labelledBy = attr('aria-labelledby');
  if (labelledBy) {
    const root = element.getRootNode() as Document | ShadowRoot;
    const labelledText = normalizeText(
      labelledBy
        .split(/\s+/)
        .map((id) => {
          const labelElement = root.getElementById ? root.getElementById(id) : null;
          return labelElement && labelElement !== element ? contentName(labelElement, true) : '';
        })
        .join(' '),
    );
    if (labelledText) {
      return clip(labelledText, 150);
    }
  }
  const ariaLabel = normalizeText(attr('aria-label'));
  if (ariaLabel) {
    return clip(ariaLabel, 150);
  }
  if ((element as HTMLInputElement).labels && (element as HTMLInputElement).labels!.length) {
    const labelText = normalizeText(
      [...(element as HTMLInputElement).labels!].map((label) => contentName(label, true)).join(' '),
    );
    if (labelText) {
      return clip(labelText, 150);
    }
  }
  if (tag === 'INPUT') {
    const inputType = (element as HTMLInputElement).type;
    if (inputType === 'submit' || inputType === 'reset' || inputType === 'button') {
      const value = normalizeText((element as HTMLInputElement).value);
      if (value) {
        return value;
      }
      if (inputType === 'submit') {
        return 'Submit';
      }
      return inputType === 'reset' ? 'Reset' : '';
    }
    if (inputType === 'image') {
      return normalizeText(attr('alt') || (element as HTMLInputElement).value);
    }
  }
  if ((tag === 'IMG' || tag === 'AREA') && normalizeText(attr('alt'))) {
    return clip(normalizeText(attr('alt')), 150);
  }
  if (tag.toLowerCase() === 'svg') {
    const title = element.querySelector('title');
    if (title) {
      return clip(normalizeText(title.textContent), 150);
    }
  }
  if (tag === 'FIELDSET') {
    const legend = element.querySelector(':scope > legend');
    if (legend) {
      return contentName(legend, true);
    }
  }
  if (tag === 'TABLE' && (element as HTMLTableElement).caption) {
    return contentName((element as HTMLTableElement).caption!, true);
  }
  if (tag === 'FIGURE') {
    const caption = element.querySelector(':scope > figcaption');
    if (caption) {
      return contentName(caption, true);
    }
  }
  if (NAME_FROM_CONTENT.has(role)) {
    const contentText = contentName(element, false);
    if (contentText) {
      return role === 'generic' ? clip(contentText, 100) : contentText;
    }
  }
  const placeholder = TEXT_ROLES.has(role)
    ? attr('placeholder') || attr('aria-placeholder') || attr('data-placeholder')
    : '';
  return clip(
    normalizeText(attr('title') || placeholder || (/^(INPUT|SELECT|TEXTAREA)$/.test(tag) ? rowLabel(element) : '')),
    150,
  );
};

// An unlabeled field in a table row takes the row's first cell, so Hacker News's login reads "username:".
export const rowLabel = (element: Element) => {
  const cell = element.closest('td');
  const row = cell && (cell.parentElement as HTMLTableRowElement | null);
  return row && row.cells && row.cells[0] !== cell ? normalizeText(row.cells[0]!.innerText) : '';
};

export const statesOf = (element: Element, role: string, name: string): string[] => {
  const states = [];
  const tag = element.tagName;

  const attr = (attributeName: string) => element.getAttribute(attributeName);

  const type = tag === 'INPUT' ? (element as HTMLInputElement).type || 'text' : '';
  if (role === 'heading') {
    states.push('level=' + (attr('aria-level') || (/^H[1-6]$/.test(tag) ? tag[1] : '2')));
  }
  if (type && !['text', 'checkbox', 'radio', 'submit', 'button', 'reset', 'image'].includes(type)) {
    states.push('type=' + type);
  }
  if (tag === 'SELECT') {
    const selectedLabels = [...(element as HTMLSelectElement).selectedOptions].map((option) =>
      normalizeText(option.label || option.text),
    );
    if ((element as HTMLSelectElement).multiple) {
      states.push('multiselectable');
      if (selectedLabels.length) {
        states.push('selected=' + quote(clip(selectedLabels.join(', '), 200)));
      }
    } else if (selectedLabels.length) {
      states.push('value=' + quote(clip(selectedLabels[0]!, 200)));
    }
  } else if (tag === 'INPUT' && isSecret(element)) {
    if ((element as HTMLInputElement).value) {
      states.push('value=(hidden)');
    }
  } else if ((tag === 'INPUT' || tag === 'TEXTAREA') && TEXT_ROLES.has(role)) {
    if ((element as HTMLInputElement).value) {
      states.push(
        'value=' +
          quote(
            clip(
              tag === 'TEXTAREA'
                ? (element as HTMLInputElement).value.trim()
                : normalizeText((element as HTMLInputElement).value),
              200,
            ),
          ),
      );
    }
  } else if (role === 'textbox' && (element as HTMLElement).isContentEditable) {
    const value = normalizeText((element as HTMLElement).innerText);
    if (value) {
      states.push('value=' + quote(clip(value, 200)));
    }
  } else if (attr('aria-valuenow') !== null) {
    states.push('value=' + quote(clip(normalizeText(attr('aria-valuetext') || attr('aria-valuenow')), 100)));
  }
  if (type === 'checkbox' || type === 'radio') {
    const input = element as HTMLInputElement;
    if (input.indeterminate) {
      states.push('mixed');
    } else {
      states.push(input.checked ? 'checked' : 'unchecked');
    }
  } else if (attr('aria-checked') !== null) {
    const value = attr('aria-checked');
    if (value === 'true') {
      states.push('checked');
    } else {
      states.push(value === 'mixed' ? 'mixed' : 'unchecked');
    }
  }
  if (attr('aria-pressed') === 'true') {
    states.push('pressed');
  }
  if (attr('aria-selected') === 'true' || (tag === 'OPTION' && (element as HTMLOptionElement).selected)) {
    states.push('selected');
  }
  if (tag === 'SUMMARY' && element.parentElement && element.parentElement.tagName === 'DETAILS') {
    states.push((element.parentElement as HTMLDetailsElement).open ? 'expanded' : 'collapsed');
  } else if (attr('aria-expanded') !== null) {
    states.push(attr('aria-expanded') === 'true' ? 'expanded' : 'collapsed');
  }
  if (attr('aria-haspopup') && attr('aria-haspopup') !== 'false') {
    states.push('haspopup');
  }
  if (isDisabled(element)) {
    states.push('disabled');
  }
  if (
    ((tag === 'INPUT' || tag === 'TEXTAREA') && (element as HTMLInputElement).readOnly) ||
    attr('aria-readonly') === 'true'
  ) {
    states.push('readonly');
  }
  if ((element as HTMLInputElement).required || attr('aria-required') === 'true') {
    states.push('required');
  }
  if (role === 'link' && attr('href')) {
    states.push('href=' + quote(clip(attr('href')!, 150)));
  }
  const placeholder = normalizeText(attr('placeholder') || attr('aria-placeholder'));
  if (placeholder && !(element as HTMLInputElement).value && placeholder !== name) {
    states.push('placeholder=' + quote(clip(placeholder, 100)));
  }
  if (element === deepActive()) {
    states.push('focused');
  }
  return states;
};
