import { describe, expect, it } from 'vitest';
import type { IdeationNode } from '@/lib/graph/ideation-types';
import {
  indentOutlineSelection,
  reconcileIdeationOutline,
  serializeIdeationOutline,
} from '@/lib/ideation/text-outline';

const nodes: IdeationNode[] = [
  {
    id: 'root',
    label: 'Launch',
    kind: 'idea',
    parentId: null,
    sortOrder: 0,
    properties: {},
  },
  {
    id: 'phase',
    label: 'Research',
    kind: 'phase',
    parentId: 'root',
    sortOrder: 0,
    properties: {},
  },
  {
    id: 'task',
    label: 'Interview users',
    kind: 'task',
    parentId: 'phase',
    sortOrder: 0,
    properties: {
      priority: { key: 'priority', rawValue: 'high', value: 'high' },
      tags: { key: 'tags', rawValue: '#discovery', value: ['discovery'] },
    },
  },
];

describe('ideation text outline', () => {
  it('serializes hierarchy, types, and title attributes as editable text', () => {
    expect(serializeIdeationOutline(nodes)).toBe([
      'Launch',
      '  [phase] Research',
      '    [task] Interview users !high #discovery',
    ].join('\n'));
  });

  it('reconciles inserted and edited lines while preserving matching node identities', () => {
    let nextId = 0;
    const reconciled = reconcileIdeationOutline(nodes, [
      'Launch',
      '  [phase] Research and validate',
      '    [task] Draft survey',
      '    [task] Interview users !critical #discovery',
    ].join('\n'), () => `new-${nextId++}`);

    expect(reconciled).toEqual([
      expect.objectContaining({ id: 'root', label: 'Launch', parentId: null }),
      expect.objectContaining({ id: 'phase', label: 'Research and validate', parentId: 'root' }),
      expect.objectContaining({ id: 'new-0', label: 'Draft survey', parentId: 'phase', kind: 'task' }),
      expect.objectContaining({
        id: 'task',
        label: 'Interview users',
        parentId: 'phase',
        properties: expect.objectContaining({
          priority: expect.objectContaining({ value: 'critical' }),
          tags: expect.objectContaining({ value: ['discovery'] }),
        }),
      }),
    ]);
  });

  it('preserves identity and hidden properties when a line moves to another parent', () => {
    const withNotes = nodes.map((node) => node.id === 'task'
      ? {
        ...node,
        properties: {
          ...node.properties,
          notes: { key: 'notes' as const, rawValue: 'Keep me', value: 'Keep me' },
          due: { key: 'due' as const, rawValue: 'tomorrow', value: '2026-08-02' },
        },
      }
      : node);

    const reconciled = reconcileIdeationOutline(withNotes, [
      'Launch',
      '  [phase] Research',
      '  [task] Interview users !high #discovery',
    ].join('\n'));
    const moved = reconciled.find((node) => node.label === 'Interview users');

    expect(moved).toEqual(expect.objectContaining({
      id: 'task',
      parentId: 'root',
      properties: expect.objectContaining({
        notes: expect.objectContaining({ value: 'Keep me' }),
        due: expect.objectContaining({ value: '2026-08-02' }),
      }),
    }));
  });

  it('removes text attributes when their tokens are removed', () => {
    const reconciled = reconcileIdeationOutline(nodes, [
      'Launch',
      '  [phase] Research',
      '    [task] Interview users',
    ].join('\n'));
    const task = reconciled.find((node) => node.id === 'task');

    expect(task?.properties.priority).toBeUndefined();
    expect(task?.properties.tags).toBeUndefined();
  });

  it('round trips tags containing spaces without changing the title', () => {
    const tagged = nodes.map((node) => node.id === 'task'
      ? {
        ...node,
        properties: {
          ...node.properties,
          tags: {
            key: 'tags' as const,
            rawValue: 'customer research',
            value: ['customer research'],
          },
        },
      }
      : node);
    const serialized = serializeIdeationOutline(tagged);
    const reconciled = reconcileIdeationOutline(tagged, serialized);
    const task = reconciled.find((node) => node.id === 'task');

    expect(serialized).toContain('#["customer research"]');
    expect(task?.label).toBe('Interview users');
    expect(task?.properties.tags?.value).toEqual(['customer research']);
  });

  it('quotes token-like label text so round trips do not create attributes', () => {
    const tokenLabels = nodes.map((node) => node.id === 'task'
      ? {
        ...node,
        label: '[task] Investigate #auth !high',
        properties: {
          priority: { key: 'priority' as const, rawValue: 'medium', value: 'medium' },
          tags: { key: 'tags' as const, rawValue: '#planned', value: ['planned'] },
        },
      }
      : node);
    const serialized = serializeIdeationOutline(tokenLabels);
    const reconciled = reconcileIdeationOutline(tokenLabels, serialized);
    const task = reconciled.find((node) => node.id === 'task');

    expect(serialized).toContain('[task] "[task] Investigate #auth !high" !medium #planned');
    expect(task).toEqual(expect.objectContaining({
      label: '[task] Investigate #auth !high',
      properties: {
        priority: expect.objectContaining({ value: 'medium' }),
        tags: expect.objectContaining({ value: ['planned'] }),
      },
    }));
  });

  it('treats replacing a line in place as a full rename and preserves hidden properties', () => {
    const withNotes = nodes.map((node) => node.id === 'task'
      ? {
        ...node,
        properties: {
          notes: { key: 'notes' as const, rawValue: 'Private context', value: 'Private context' },
        },
      }
      : node);
    const reconciled = reconcileIdeationOutline(withNotes, [
      'Launch',
      '  [phase] Research',
      '    [task] Publish announcement',
    ].join('\n'), () => 'replacement');
    const replacement = reconciled.find((node) => node.label === 'Publish announcement');

    expect(replacement).toEqual(expect.objectContaining({
      id: 'task',
      properties: expect.objectContaining({
        notes: expect.objectContaining({ value: 'Private context' }),
      }),
    }));
  });

  it('returns the existing array for a semantic no-op regardless of storage order', () => {
    const storageOrdered = [nodes[0], nodes[2], nodes[1]];

    expect(
      reconcileIdeationOutline(storageOrdered, serializeIdeationOutline(storageOrdered)),
    ).toBe(storageOrdered);
  });

  it('treats additional unindented lines as children of the single project root', () => {
    const reconciled = reconcileIdeationOutline(nodes.slice(0, 1), [
      'Launch',
      'First idea',
      'Second idea',
    ].join('\n'), () => crypto.randomUUID());

    expect(reconciled.slice(1)).toEqual([
      expect.objectContaining({ label: 'First idea', parentId: 'root' }),
      expect.objectContaining({ label: 'Second idea', parentId: 'root' }),
    ]);
  });

  it('indents and outdents all selected lines', () => {
    const value = 'Launch\nFirst\nSecond';
    const indented = indentOutlineSelection(value, 7, value.length, false);
    expect(indented.value).toBe('Launch\n  First\n  Second');

    const outdented = indentOutlineSelection(
      indented.value,
      indented.selectionStart,
      indented.selectionEnd,
      true,
    );
    expect(outdented.value).toBe(value);
  });

  it('does not indent the next line when selection ends at its start', () => {
    const value = 'Launch\nFirst\nSecond';
    const selectionStart = value.indexOf('First');
    const selectionEnd = value.indexOf('Second');
    const indented = indentOutlineSelection(value, selectionStart, selectionEnd, false);

    expect(indented.value).toBe('Launch\n  First\nSecond');
  });
});
