import { describe, expect, it } from 'vitest';
import {
  buildPhasePlanningTaskContext,
  normalizePhaseProposal,
  parsePhaseProposalText,
  type PhasePlanningContextTask,
} from '@/lib/projects/phase-planning';

function makeTask(
  id: string,
  overrides: Partial<PhasePlanningContextTask> = {},
): PhasePlanningContextTask {
  return {
    id,
    title: `Task ${id}`,
    priority: 'medium',
    dueDate: null,
    tags: [],
    status: 'todo',
    connectorType: 'local',
    sourceListName: null,
    updatedAt: '2026-08-16T00:00:00.000Z',
    description: null,
    projectNames: ['Project one'],
    ...overrides,
  };
}

describe('phase planning proposal parsing', () => {
  it('parses fenced and embedded JSON objects', () => {
    expect(parsePhaseProposalText('```json\n{"phases":[]}\n```'))
      .toEqual({ phases: [] });
    expect(parsePhaseProposalText('Result: {"phases":[]}\nThanks'))
      .toEqual({ phases: [] });
  });

  it('returns null for malformed or missing JSON', () => {
    expect(parsePhaseProposalText('```json\n{bad}\n```')).toBeNull();
    expect(parsePhaseProposalText('No proposal')).toBeNull();
  });
});

describe('shared phase proposal normalization', () => {
  const tasks = [
    makeTask('one', { title: 'First task' }),
    makeTask('two', { title: 'Second task' }),
    makeTask('three', { title: 'Third task' }),
  ];

  it('normalizes model output and keeps every non-closure task exactly once', () => {
    const proposal = normalizePhaseProposal({
      phases: [
        {
          name: '  Build  ',
          description: '  Main work  ',
          color: '#3B82F6',
          estimatedDays: '2.4',
          taskIds: ['one', 'missing', 'one', 'three'],
          reasoning: '  grouped  ',
        },
        {
          name: 'Finish',
          taskIds: ['one', 'two'],
        },
      ],
      overallReasoning: '  ordered  ',
      suggestedNewTasks: [
        { title: '  Follow up  ', description: '  desc  ', phase: '  Finish  ', reasoning: '  gap  ' },
        { title: '   ' },
      ],
      suggestedClosures: [
        { taskId: 'three', title: '', reasoning: '  duplicate  ' },
        { taskId: 'missing', title: 'Missing' },
      ],
    }, tasks, { kind: 'suggest' });

    expect(proposal.phases).toEqual([
      expect.objectContaining({
        name: 'Build',
        description: 'Main work',
        color: '#3b82f6',
        estimatedDays: 2,
        taskIds: ['one'],
        reasoning: 'grouped',
      }),
      expect.objectContaining({
        name: 'Finish',
        taskIds: ['two'],
      }),
    ]);
    expect(proposal.overallReasoning).toBe('ordered');
    expect(proposal.suggestedNewTasks).toEqual([{
      title: 'Follow up',
      description: 'desc',
      phase: 'Finish',
      reasoning: 'gap',
    }]);
    expect(proposal.suggestedClosures).toEqual([{
      taskId: 'three',
      title: 'Third task',
      reasoning: 'duplicate',
    }]);
    expect(proposal.phases.flatMap((phase) => phase.taskIds)).not.toContain('three');
  });

  it('makes suggest and refine fallback differences explicit', () => {
    const duplicateTasks = [
      makeTask('one', { title: 'Duplicate', tags: ['Design'] }),
      makeTask('two', { title: 'Duplicate', tags: ['Design'] }),
    ];

    const suggestion = normalizePhaseProposal(null, duplicateTasks, {
      kind: 'suggest',
      phaseCount: 1,
    });
    const refinement = normalizePhaseProposal(null, duplicateTasks, {
      kind: 'refine',
      currentPhases: [{ name: 'Existing phase', taskIds: ['one', 'two'] }],
      instruction: 'Keep the current shape',
    });

    expect(suggestion.phases[0].name).toBe('Phase 1: Design');
    expect(suggestion.overallReasoning).toContain('Fallback plan');
    expect(refinement.phases[0].name).toBe('Existing phase');
    expect(refinement.overallReasoning).toContain('Keep the current shape');
    expect(suggestion.suggestedClosures).toEqual(refinement.suggestedClosures);
  });

  it('uses mode-specific names and reasoning when recovering omitted tasks', () => {
    const raw = {
      phases: [{ name: '', taskIds: [] }],
      overallReasoning: '',
    };

    const suggestion = normalizePhaseProposal(raw, [tasks[0]], { kind: 'suggest' });
    const refinement = normalizePhaseProposal(raw, [tasks[0]], {
      kind: 'refine',
      currentPhases: [{ name: 'Discovery', taskIds: ['one'] }],
    });

    expect(suggestion.phases[0]).toMatchObject({
      name: 'Phase 1',
      reasoning: expect.stringContaining('single phase'),
    });
    expect(suggestion.overallReasoning).toContain('grouped into sequential phases');
    expect(refinement.phases[0]).toMatchObject({
      name: 'Discovery',
      reasoning: expect.stringContaining('first phase'),
    });
    expect(refinement.overallReasoning).toContain('phases were refined');
  });

  it('shares task-context formatting between suggest and refine callers', () => {
    expect(buildPhasePlanningTaskContext([
      makeTask('one', {
        connectorType: 'microsoft-todo',
        sourceListName: 'Work',
        description: 'A   spaced description',
      }),
    ])).toContain(
      'source: microsoft-todo / Work | updated: 2026-08-16T00:00:00.000Z | description: A spaced description',
    );
  });
});
