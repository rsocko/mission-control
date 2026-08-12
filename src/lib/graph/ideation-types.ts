export type IdeationNodeKind = 'idea' | 'phase' | 'task';
export type IdeationPropertyKey =
  | 'priority'
  | 'status'
  | 'due'
  | 'effort'
  | 'tags'
  | 'assignee'
  | 'depends-on'
  | 'related'
  | 'notes';

export type IdeationPropertyValue = string | number | string[];

export const IDEATION_PRIORITIES = ['critical', 'high', 'medium', 'low', 'none'] as const;
export const IDEATION_STATUSES = ['todo', 'in_progress', 'done', 'blocked'] as const;

export interface IdeationProperty {
  key: IdeationPropertyKey;
  rawValue: string;
  value: IdeationPropertyValue;
}

export interface IdeationNode {
  id: string;
  label: string;
  kind: IdeationNodeKind;
  parentId: string | null;
  sortOrder: number;
  properties: Partial<Record<IdeationPropertyKey, IdeationProperty>>;
}

export type IdeationTreeNode<T extends IdeationNode = IdeationNode> = T & {
  children: IdeationTreeNode<T>[];
};

export interface ConvertIdeationPayload {
  name: string;
  color: string;
  nodes: IdeationNode[];
}

export const IDEATION_KIND_ORDER: IdeationNodeKind[] = ['idea', 'phase', 'task'];

export function buildIdeationTree<T extends IdeationNode>(nodes: T[]): IdeationTreeNode<T>[] {
  const childrenByParent = new Map<string | null, T[]>();
  const nodeIds = new Set(nodes.map((node) => node.id));

  for (const node of nodes) {
    const parentId = node.parentId && nodeIds.has(node.parentId) ? node.parentId : null;
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(parentId, siblings);
  }

  const buildChildren = (parentId: string | null): IdeationTreeNode<T>[] => (
    (childrenByParent.get(parentId) ?? [])
      .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label))
      .map((node) => ({
        ...node,
        children: buildChildren(node.id),
      }))
  );

  return buildChildren(null);
}

export function isIdeationDescendant(
  nodes: IdeationNode[],
  candidateId: string,
  ancestorId: string,
): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let current = byId.get(candidateId);

  while (current?.parentId) {
    if (current.parentId === ancestorId) return true;
    current = byId.get(current.parentId);
  }

  return false;
}
