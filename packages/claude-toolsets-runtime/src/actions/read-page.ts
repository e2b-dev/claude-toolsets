import { ActionError } from '../contract.ts';
import type { OperationArgs } from '../contract.ts';
import type { ReferenceStore } from '../references.ts';
import { clip, quote } from '../text.ts';
import { build, buildChildren, textInView, lineOf, type TreeNode } from '../tree.ts';
import { CONTEXT } from '../accessibility.ts';

export function readPage(refs: ReferenceStore, args: OperationArgs['read_page']) {
  const mode = args.filter === 'interactive' ? 'interactive' : 'visible';
  let all = args.filter === 'all';
  let nodes: TreeNode[];
  if (args.ref) {
    const element = refs.lookup(args.ref);
    all = true;
    nodes = build(element, false, true);
    if (!nodes.length) {
      throw new ActionError(
        'action_failed',
        args.ref + ' is not visible on the page; call read_page without ref to see what is shown',
      );
    }
  } else {
    if (!document.body) {
      return '';
    }
    nodes = buildChildren(document.body, false);
  }
  let offscreen = 0;

  // Items carry a level relative to their emitted parent, so a dropped wrapper lifts its children.
  const render = (list: TreeNode[]): { level: number; text: string }[] => {
    const items = [];
    for (const node of list) {
      if ('text' in node) {
        if (mode === 'interactive') {
          continue;
        }
        if (!all && !textInView(node)) {
          offscreen++;
          continue;
        }
        items.push({ level: 0, text: '- text ' + quote(clip(node.text, 300)) });
        continue;
      }
      const child = render(node.children);
      const self = node.boxes.length > 0 && (mode !== 'interactive' || node.interactive);
      const shown = all || node.inView;
      if (self && !shown && node.interactive) {
        offscreen++;
      }
      if ((self && shown) || (child.length && (mode !== 'interactive' || CONTEXT.has(node.role)))) {
        items.push({ level: 0, text: lineOf(refs, node) });
        for (const childItem of child) {
          items.push({ level: childItem.level + 1, text: childItem.text });
        }
      } else {
        items.push(...child);
      }
    }
    return items;
  };

  const items = render(nodes);
  const lines = [];
  let size = 0;
  let truncated = false;
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    if (item.level >= args.depth) {
      continue;
    }
    let line = '  '.repeat(item.level) + item.text;
    const next = items[index + 1];
    if (item.level === args.depth - 1 && next && next.level > item.level) {
      line += ' (children omitted: depth limit)';
    }
    if (size + line.length + 1 > args.cap) {
      truncated = true;
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  if (truncated) {
    lines.push('[Output truncated at ' + args.cap + ' characters; read a subtree with ref or use a smaller depth]');
  }
  if (!all && offscreen) {
    lines.push('[' + offscreen + ' more items are outside the viewport; scroll, or call read_page with filter "all"]');
  }
  return lines.join('\n');
}
