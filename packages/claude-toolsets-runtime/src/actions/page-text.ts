import type { OperationArgs } from '../contract.ts';
import type { ReferenceStore } from '../references.ts';
import { normalizeText } from '../text.ts';

export function pageText(_refs: ReferenceStore, args: OperationArgs['page_text']) {
  if (!document.body) {
    return '';
  }

  const hasLongVisibleText = (element: HTMLElement | null | undefined): element is HTMLElement =>
    !!element && element.checkVisibility() && normalizeText(element.innerText).length > 200;

  const articles = [...document.querySelectorAll<HTMLElement>('article')].filter(hasLongVisibleText);
  const main = document.querySelector<HTMLElement>('main, [role="main"]');
  let root = document.body;
  if (articles.length === 1) {
    root = articles[0]!;
  } else if (hasLongVisibleText(main)) {
    root = main;
  }
  const text = (root.innerText || '')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length <= args.max) {
    return text;
  }
  return (
    text.slice(0, args.max).trimEnd() +
    '\n\n[Truncated: showing the first ' +
    args.max +
    ' of ' +
    text.length +
    ' characters. Use find, or read_page with a ref, to reach the rest]'
  );
}
