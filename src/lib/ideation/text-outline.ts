import {
  buildIdeationTree,
  type IdeationNode,
  type IdeationNodeKind,
  type IdeationProperty,
  type IdeationTreeNode,
} from '@/lib/graph/ideation-types';
import { parseIdeationTitleTokens } from '@/lib/ideation/property-parser';

const INDENT = '  ';

interface DraftNode {
  label: string;
  kind: IdeationNodeKind | null;
  properties: IdeationProperty[];
  children: DraftNode[];
}

function labelNeedsQuoting(label: string): boolean {
  return label.startsWith('"')
    || /^\[(idea|phase|task)\](?:\s|$)/i.test(label)
    || /(?:^|\s)(?:!(?:critical|urgent|high|medium|low|none)|#[a-z0-9][a-z0-9_-]*)(?=\s|$)/i.test(label)
    || /#\["(?:\\.|[^"\\])*"\]/.test(label);
}

function serializedLabel(label: string): string {
  return labelNeedsQuoting(label) ? JSON.stringify(label) : label;
}

function closingQuoteIndex(value: string): number {
  let escaped = false;
  for (let index = 1; index < value.length; index += 1) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (value[index] === '\\') {
      escaped = true;
      continue;
    }
    if (value[index] === '"') return index;
  }
  return -1;
}

function titleWithTokens(node: IdeationNode): string {
  const tokens: string[] = [];
  const priority = node.properties.priority?.value;
  if (typeof priority === 'string') tokens.push(`!${priority}`);
  const tags = node.properties.tags?.value;
  if (Array.isArray(tags)) {
    tokens.push(...tags.map((tag) => (
      /^[a-z0-9][a-z0-9_-]*$/i.test(tag)
        ? `#${tag}`
        : `#${JSON.stringify([tag])}`
    )));
  }
  return [serializedLabel(node.label), ...tokens].join(' ');
}

function nodePrefix(kind: IdeationNodeKind): string {
  return kind === 'idea' ? '' : `[${kind}] `;
}

export function serializeIdeationOutline(nodes: IdeationNode[]): string {
  const lines: string[] = [];
  const visit = (node: IdeationTreeNode, depth: number) => {
    lines.push(`${INDENT.repeat(depth)}${nodePrefix(node.kind)}${titleWithTokens(node)}`);
    node.children.forEach((child) => visit(child, depth + 1));
  };
  buildIdeationTree(nodes).forEach((root) => visit(root, 0));
  return lines.join('\n');
}

function parseDraftOutline(input: string): DraftNode[] {
  const roots: DraftNode[] = [];
  const ancestors: DraftNode[] = [];
  let previousDepth = 0;

  for (const rawLine of input.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const whitespace = rawLine.match(/^[\t ]*/)?.[0] ?? '';
    const spaces = [...whitespace].reduce((total, character) => (
      total + (character === '\t' ? INDENT.length : 1)
    ), 0);
    const requestedDepth = Math.floor(spaces / INDENT.length);
    const depth = roots.length
      ? Math.max(1, Math.min(requestedDepth, previousDepth + 1))
      : 0;
    const content = rawLine.trim();
    const kindMatch = content.match(/^\[(idea|phase|task)\]\s*/i);
    const kind = kindMatch?.[1].toLowerCase() as IdeationNodeKind | undefined;
    const encodedTags: string[] = [];
    const unprefixedContent = content.slice(kindMatch?.[0].length ?? 0);
    let quotedLabel: string | null = null;
    let propertyInput = unprefixedContent;
    if (unprefixedContent.startsWith('"')) {
      const index = closingQuoteIndex(unprefixedContent);
      if (index !== -1) {
        try {
          const parsedLabel = JSON.parse(unprefixedContent.slice(0, index + 1)) as unknown;
          if (typeof parsedLabel === 'string') {
            quotedLabel = parsedLabel;
            propertyInput = unprefixedContent.slice(index + 1);
          }
        } catch {
          quotedLabel = null;
        }
      }
    }
    const titleInput = propertyInput
      .replace(/#(\["(?:\\.|[^"\\])*"\])/g, (token, encoded: string) => {
        try {
          const values = JSON.parse(encoded) as unknown;
          if (Array.isArray(values) && values.length === 1 && typeof values[0] === 'string') {
            encodedTags.push(values[0]);
            return '';
          }
        } catch {
          return token;
        }
        return token;
      });
    const parsed = parseIdeationTitleTokens(
      quotedLabel === null ? titleInput : `__quoted_label__ ${titleInput}`,
    );
    const simpleTags = parsed.properties.find((property) => property.key === 'tags');
    const properties = parsed.properties.filter((property) => property.key !== 'tags');
    const tags = [
      ...(Array.isArray(simpleTags?.value) ? simpleTags.value : []),
      ...encodedTags,
    ];
    if (tags.length) {
      properties.push({
        key: 'tags',
        rawValue: tags.map((tag) => `#${tag}`).join(', '),
        value: tags,
      });
    }
    const label = quotedLabel ?? parsed.label;
    if (!label) continue;
    const draft: DraftNode = {
      label,
      kind: kind ?? null,
      properties,
      children: [],
    };

    if (depth === 0) {
      roots.push(draft);
    } else {
      const parent = ancestors[depth - 1] ?? ancestors.at(-1);
      if (parent) parent.children.push(draft);
      else roots.push(draft);
    }
    ancestors[depth] = draft;
    ancestors.length = depth + 1;
    previousDepth = depth;
  }
  return roots;
}

function normalizedLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function mergeParsedProperties(
  existing: IdeationNode['properties'],
  parsed: IdeationProperty[],
): IdeationNode['properties'] {
  const properties = { ...existing };
  delete properties.priority;
  delete properties.tags;
  for (const property of parsed) properties[property.key] = property;
  return properties;
}

function propertyValuesEqual(
  first: IdeationProperty['value'],
  second: IdeationProperty['value'],
): boolean {
  if (Array.isArray(first) && Array.isArray(second)) {
    return first.length === second.length && first.every((value, index) => value === second[index]);
  }
  return first === second;
}

function nodeSemanticallyEquals(first: IdeationNode, second: IdeationNode): boolean {
  if (
    first.id !== second.id
    || first.label !== second.label
    || first.kind !== second.kind
    || first.parentId !== second.parentId
    || first.sortOrder !== second.sortOrder
  ) {
    return false;
  }
  const firstKeys = Object.keys(first.properties);
  const secondKeys = Object.keys(second.properties);
  return firstKeys.length === secondKeys.length && firstKeys.every((key) => {
    const propertyKey = key as keyof IdeationNode['properties'];
    const firstProperty = first.properties[propertyKey];
    const secondProperty = second.properties[propertyKey];
    return Boolean(
      firstProperty
      && secondProperty
      && firstProperty.key === secondProperty.key
      && propertyValuesEqual(firstProperty.value, secondProperty.value),
    );
  });
}

export function reconcileIdeationOutline(
  currentNodes: IdeationNode[],
  input: string,
  createId: () => string = () => crypto.randomUUID(),
): IdeationNode[] {
  const draftRoots = parseDraftOutline(input);
  if (!draftRoots.length) return currentNodes;

  const currentTree = buildIdeationTree(currentNodes);
  const globallyUsedIds = new Set<string>();
  const existingByLabel = new Map<string, IdeationTreeNode[]>();
  const indexExisting = (node: IdeationTreeNode) => {
    const label = normalizedLabel(node.label);
    existingByLabel.set(label, [...(existingByLabel.get(label) ?? []), node]);
    node.children.forEach(indexExisting);
  };
  currentTree.forEach(indexExisting);
  const reconcileSiblings = (
    drafts: DraftNode[],
    existing: IdeationTreeNode[],
    parentId: string | null,
  ): IdeationNode[] => {
    const matches = new Map<DraftNode, IdeationTreeNode>();
    for (const draft of drafts) {
      const exact = existing.find((node) => (
        !globallyUsedIds.has(node.id)
        && normalizedLabel(node.label) === normalizedLabel(draft.label)
      ));
      if (exact) {
        matches.set(draft, exact);
        globallyUsedIds.add(exact.id);
        continue;
      }
      const globalMatches = existingByLabel.get(normalizedLabel(draft.label)) ?? [];
      const globalExact = globalMatches.length === 1 ? globalMatches[0] : null;
      if (
        globalExact
        && !globallyUsedIds.has(globalExact.id)
        && (parentId === null) === (globalExact.parentId === null)
      ) {
        matches.set(draft, globalExact);
        globallyUsedIds.add(globalExact.id);
      }
    }
    drafts.forEach((draft, index) => {
      if (matches.has(draft)) return;
      const positional = existing[index];
      if (positional && !globallyUsedIds.has(positional.id)) {
        matches.set(draft, positional);
        globallyUsedIds.add(positional.id);
      }
    });

    return drafts.flatMap((draft, sortOrder) => {
      const match = matches.get(draft);
      const id = match?.id ?? createId();
      const node: IdeationNode = {
        id,
        label: draft.label,
        kind: draft.kind ?? match?.kind ?? 'idea',
        parentId,
        sortOrder,
        properties: mergeParsedProperties(match?.properties ?? {}, draft.properties),
      };
      return [
        node,
        ...reconcileSiblings(draft.children, match?.children ?? [], id),
      ];
    });
  };

  const roots = draftRoots.length > 1
    ? [{
      ...draftRoots[0],
      children: [...draftRoots[0].children, ...draftRoots.slice(1)],
    }]
    : draftRoots;
  const reconciled = reconcileSiblings(roots, currentTree, null);
  const reconciledById = new Map(reconciled.map((node) => [node.id, node]));
  return currentNodes.length === reconciled.length
    && currentNodes.every((node) => {
      const nextNode = reconciledById.get(node.id);
      return nextNode ? nodeSemanticallyEquals(node, nextNode) : false;
    })
    ? currentNodes
    : reconciled;
}

export interface TextSelectionEdit {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

export function indentOutlineSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  outdent: boolean,
): TextSelectionEdit {
  const blockStart = value.lastIndexOf('\n', Math.max(0, selectionStart - 1)) + 1;
  const effectiveEnd = selectionEnd > selectionStart && value[selectionEnd - 1] === '\n'
    ? selectionEnd - 1
    : selectionEnd;
  const nextBreak = value.indexOf('\n', effectiveEnd);
  const blockEnd = nextBreak === -1 ? value.length : nextBreak;
  const lines = value.slice(blockStart, blockEnd).split('\n');

  if (outdent) {
    const removed = lines.map((line) => {
      if (line.startsWith('\t')) return 1;
      return Math.min(line.match(/^ */)?.[0].length ?? 0, INDENT.length);
    });
    const replacement = lines.map((line, index) => line.slice(removed[index])).join('\n');
    const removedBeforeStart = removed[0];
    const removedTotal = removed.reduce((total, count) => total + count, 0);
    return {
      value: `${value.slice(0, blockStart)}${replacement}${value.slice(blockEnd)}`,
      selectionStart: Math.max(blockStart, selectionStart - removedBeforeStart),
      selectionEnd: Math.max(blockStart, selectionEnd - removedTotal),
    };
  }

  const replacement = lines.map((line) => `${INDENT}${line}`).join('\n');
  return {
    value: `${value.slice(0, blockStart)}${replacement}${value.slice(blockEnd)}`,
    selectionStart: selectionStart + INDENT.length,
    selectionEnd: selectionEnd + INDENT.length * lines.length,
  };
}
