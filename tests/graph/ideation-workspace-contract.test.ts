import { describe, expect, it } from 'vitest';
import {
  createIdeationWorkspaceDocument,
  ideationWorkspaceDocumentSchema,
  parseLegacyIdeationDraft,
} from '@/lib/graph-workspace/ideation-contract';

const root = {
  id: 'root',
  label: 'Workspace',
  kind: 'idea' as const,
  parentId: null,
  sortOrder: 0,
  properties: {},
};

describe('Ideation workspace document contract', () => {
  it('round-trips every existing Ideation property without loss', () => {
    const document = createIdeationWorkspaceDocument([
      root,
      {
        id: 'task',
        label: 'Ship it',
        kind: 'task',
        parentId: root.id,
        sortOrder: 0,
        properties: {
          priority: { key: 'priority', rawValue: 'high', value: 'high' },
          status: { key: 'status', rawValue: 'in_progress', value: 'in_progress' },
          due: { key: 'due', rawValue: '2026-08-20', value: '2026-08-20' },
          effort: { key: 'effort', rawValue: '3', value: 3 },
          tags: { key: 'tags', rawValue: 'release, backend', value: ['release', 'backend'] },
          assignee: { key: 'assignee', rawValue: 'me', value: 'me' },
          'depends-on': { key: 'depends-on', rawValue: '[[Design]]', value: ['Design'] },
          related: { key: 'related', rawValue: '[[Launch]]', value: ['Launch'] },
          notes: { key: 'notes', rawValue: 'Full fidelity', value: 'Full fidelity' },
        },
      },
    ]);

    expect(ideationWorkspaceDocumentSchema.parse(JSON.parse(JSON.stringify(document))))
      .toEqual(document);
  });

  it.each([
    {
      name: 'duplicates',
      nodes: [root, { ...root }],
      message: 'unique',
    },
    {
      name: 'orphan',
      nodes: [root, { ...root, id: 'child', parentId: 'missing' }],
      message: 'does not exist',
    },
    {
      name: 'cycle',
      nodes: [
        { ...root, parentId: 'child' },
        { ...root, id: 'child', parentId: 'root' },
      ],
      message: 'root',
    },
  ])('rejects an invalid hierarchy with $name', ({ nodes, message }) => {
    const parsed = ideationWorkspaceDocumentSchema.safeParse({
      schemaVersion: 1,
      type: 'ideation',
      nodes,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message).join(' ')).toContain(message);
    }
  });

  it('reads the existing Zustand localStorage envelope', () => {
    expect(parseLegacyIdeationDraft({
      state: { nodes: [root] },
      version: 0,
    })).toEqual({
      schemaVersion: 1,
      type: 'ideation',
      nodes: [root],
    });
  });
});
