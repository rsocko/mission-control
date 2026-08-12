import { describe, expect, it } from 'vitest';
import { computeSmartScore, createScoreInput, type PriorityEntity } from '@/lib/smart-score';

const task = {
  id: 'task-1',
  title: 'Plan launch',
  description: 'Coordinate with Jordan',
  priority: 'none' as const,
  dueDate: '2026-08-01',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-02T00:00:00.000Z',
  connectorType: 'microsoft-todo',
  connectorInstanceId: 'work',
  sourceListName: 'Leadership',
  sourceListId: 'list-1',
  assignee: 'Alex',
  snoozedUntil: '2026-07-15T00:00:00.000Z',
  effort: 2,
};

describe('createScoreInput', () => {
  it('uses every supported entity signal and scoring field', () => {
    expect(createScoreInput(
      task,
      [{ id: 'tag-1', name: 'customer' }],
      [{ id: 'project-1', name: 'Launch project' }],
    )).toEqual({
      taskId: 'task-1',
      title: 'Plan launch',
      priority: 'none',
      dueDate: '2026-08-01',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'work',
      linkedEntityNames: ['customer', 'Launch project', 'Leadership', 'Alex'],
      personText: ['Plan launch', 'Coordinate with Jordan', 'Alex'],
      linkedEntityRefs: [
        { type: 'tag', id: 'tag-1' },
        { type: 'project', id: 'project-1' },
        { type: 'source', id: 'work:list-1' },
      ],
      snoozedUntil: '2026-07-15T00:00:00.000Z',
      effort: 2,
    });
  });

  it('omits empty optional entity names', () => {
    expect(createScoreInput({
      ...task,
      sourceListName: null,
      sourceListId: null,
      assignee: null,
    }).linkedEntityNames).toEqual([]);
  });

  it('matches picker-backed entities by type and reference instead of display name', () => {
    const input = createScoreInput(
      task,
      [{ id: 'tag-1', name: 'Customer' }],
      [{ id: 'project-1', name: 'Launch' }],
    );
    const entity: PriorityEntity = {
      id: 'priority-1',
      name: 'Renamed project',
      type: 'project',
      referenceId: 'project-1',
      tier: 'critical',
      color: '#fff',
      rank: 1,
      activeTaskCount: 0,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };

    expect(computeSmartScore(input, [entity], []).matchedEntities).toEqual([
      { name: 'Renamed project', tier: 'critical', rank: 1 },
    ]);
    expect(computeSmartScore(input, [{ ...entity, referenceId: 'tag-1' }], []).matchedEntities).toEqual([]);
  });

  it('matches people mentioned in task content without requiring assignment', () => {
    const input = createScoreInput({
      ...task,
      assignee: null,
      sourceListName: null,
      title: 'Prepare the proposal for Jordan',
      description: 'Contact Jordan after legal review',
    });
    const person: PriorityEntity = {
      id: 'person-jordan',
      name: 'Jordan',
      type: 'person',
      tier: 'high',
      color: '#fff',
      rank: 1,
      activeTaskCount: 0,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };

    expect(computeSmartScore(input, [person], []).matchedEntities).toEqual([
      { name: 'Jordan', tier: 'high', rank: 1 },
    ]);
  });

  it('does not match a person name embedded inside another word', () => {
    const input = createScoreInput({
      ...task,
      assignee: null,
      title: 'Finish planning notes',
      description: null,
    });
    const person: PriorityEntity = {
      id: 'person-ann',
      name: 'Ann',
      type: 'person',
      tier: 'high',
      color: '#fff',
      rank: 1,
      activeTaskCount: 0,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };

    expect(computeSmartScore(input, [person], []).matchedEntities).toEqual([]);
  });

  it('finds a later delimited person name after an embedded occurrence', () => {
    const input = createScoreInput({
      ...task,
      assignee: null,
      sourceListName: null,
      title: 'Finish planning with Ann',
      description: null,
    });
    const person: PriorityEntity = {
      id: 'person-ann',
      name: 'Ann',
      type: 'person',
      tier: 'high',
      color: '#fff',
      rank: 1,
      activeTaskCount: 0,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };

    expect(computeSmartScore(input, [person], []).matchedEntities).toHaveLength(1);
  });
});
