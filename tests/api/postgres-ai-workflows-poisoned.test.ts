import { describe, expect, it, vi } from 'vitest';
import type { AIWorkflowPersistence } from '@/db/persistence/ai-workflows';

const orchestration = vi.hoisted(() => ({
  calls: [] as string[],
  generateText: vi.fn(async (options?: { system?: string }) => {
    const system = options?.system ?? '';
    let text = 'Recommended next action';
    if (system.includes('classify tasks by')) {
      text = JSON.stringify([{
        taskId: 'task-energy',
        energyLevel: 'high',
        confidence: 0.9,
        reason: 'Deep work',
      }]);
    } else if (system.includes('assign tasks to projects')) {
      text = JSON.stringify({
        assignments: [{ index: 1, project: 'Project One', confidence: 0.9 }],
      });
    } else if (system.includes('suggest tags for tasks')) {
      text = JSON.stringify({
        suggestions: [{ index: 1, tags: ['engineering'], confidence: 0.9 }],
      });
    } else if (system.includes('prioritization engine')) {
      text = JSON.stringify({
        rankings: [{ index: 1, score: 90, reason: 'Urgent' }],
      });
    } else if (system.includes('suggest micro-statuses')) {
      text = JSON.stringify([{
        taskId: 'task-energy',
        suggestedStatus: 'in_research',
        confidence: 0.8,
        reason: 'Active investigation',
      }]);
    } else if (system.includes('project planning assistant')) {
      text = JSON.stringify({
        phases: [{
          name: 'Build',
          description: 'Build it',
          color: '#3b82f6',
          estimatedDays: 1,
          taskIds: ['task-energy'],
          reasoning: 'First',
        }],
        overallReasoning: 'Ship in one phase',
        suggestedNewTasks: [],
        suggestedClosures: [],
        summary: 'A focused delivery plan',
        suggestedTasks: [],
        suggestedProject: null,
      });
    } else if (system.includes('productivity planner')) {
      text = JSON.stringify({ plan: [], summary: 'Plan ready', suggestions: [] });
    } else if (system.includes('productivity coach')) {
      text = JSON.stringify({
        narrative: 'Good progress',
        momentum: 'Keep going',
        attention: null,
        suggestion: 'Finish the next task',
      });
    } else if (system.includes('triage notifications')) {
      text = JSON.stringify({
        actions: [{
          index: 1,
          recommendation: 'urgent',
          reason: 'Action required',
        }],
      });
    }
    return {
      text,
      output: {
        subtasks: [{
          title: 'Implement the change',
          description: 'Complete the implementation',
          effort: 2,
        }],
      },
      response: { modelId: 'test-model', headers: {} },
    };
  }),
}));

vi.mock('@/db', () => {
  throw new Error('SQLite database module must not be evaluated');
});
vi.mock('@/db/schema', () => {
  throw new Error('SQLite schema module must not be evaluated');
});
vi.mock('better-sqlite3', () => {
  throw new Error('SQLite driver must not be evaluated');
});
vi.mock('drizzle-orm/better-sqlite3', () => {
  throw new Error('SQLite Drizzle driver must not be evaluated');
});
vi.mock('@/lib/ai/provider-configuration-service', () => ({
  loadAIProviderConfiguration: async () => {
    orchestration.calls.push('load-provider-configuration');
    return {
      resolved: {
        provider: 'ollama',
        model: 'test-model',
        embeddingProvider: 'ollama',
        embeddingModel: 'test-embedding',
        embeddingConfigured: true,
        semanticSearchEnabled: false,
        houstonMemoryEnabled: false,
        houstonMemoryRetentionDays: 90,
        configured: true,
      },
      routingPolicy: {
        policies: {
          'local-only': { allowedRoutes: ['ollama'] },
          restricted: { allowedRoutes: ['ollama'] },
          standard: { allowedRoutes: ['ollama'] },
        },
        featureDefaults: {},
        sourceDefaults: {},
      },
    };
  },
}));
vi.mock('@/lib/ai/provider-client', () => ({
  createConfiguredAIProvider: () => () => ({ modelId: 'test-model' }),
}));
vi.mock('ai', () => ({
  generateText: async (...args: unknown[]) => {
    orchestration.calls.push('model');
    return orchestration.generateText(args[0] as { system?: string });
  },
  generateObject: vi.fn(async () => ({
    object: {
      proposals: [
        { label: 'Research', rationale: 'Learn.' },
        { label: 'Prototype', rationale: 'Test.' },
        { label: 'Launch', rationale: 'Ship.' },
      ],
    },
  })),
  Output: { object: vi.fn() },
  tool: vi.fn((definition: unknown) => definition),
  zodSchema: vi.fn((schema: unknown) => schema),
}));
vi.mock('@/lib/tasks/core/runtime', () => ({
  getTaskCorePersistence: async () => ({
    policyIdentities: {
      listTaskSourceIdentities: async () => [{
        id: 'task-energy',
        sourceId: 'local:task-energy',
        connectorType: 'local',
        connectorInstanceId: 'local',
      }],
    },
    ancillary: {
      getTask: async () => null,
      getSubtaskProposalSnapshot: async () => null,
    },
  }),
}));

const empty = async () => [];
const aiWorkflows: AIWorkflowPersistence = {
  context: {
    listTaskContext: async () => [{
      id: 'task-overdue',
      title: 'Overdue',
      status: 'todo',
      priority: 'high',
      dueDate: '2026-09-01',
    }],
    getTriageContext: async () => ({
      unreadCount: 2,
      criticalCount: 1,
      categories: ['security'],
    }),
    loadDigestSnapshot: async () => ({
      counts: {
        open: 1,
        overdue: 1,
        dueToday: 0,
        inProgress: 0,
        critical: 1,
        unreadNotifications: 1,
        urgentNotifications: 1,
      },
      overdue: [{
        id: 'task-energy',
        title: 'Deep work',
        priority: 'high',
        dueDate: '2026-09-01',
        connectorType: 'local',
      }],
      dueToday: [],
      inProgress: [],
      notifications: [{
        id: 'notice-1',
        title: 'Review',
        level: 'urgent',
        connectorType: 'local',
      }],
      sources: ['local'],
      rowCount: 2,
    }),
  },
  getTaskBreakdownContext: async (taskId) => (
    taskId === 'missing'
      ? null
      : {
          task: {
            id: taskId,
            title: 'Ship feature',
            description: 'Finish the implementation',
            priority: 'high',
            dueDate: '2026-09-07',
            effort: 3,
            sourceListName: 'Work',
            connectorType: 'local',
            updatedAt: '2026-09-06T12:00:00.000Z',
          },
          tagNames: ['engineering'],
          projectNames: ['Mission Control'],
          subtaskTitles: ['Existing step'],
        }
  ),
  notifications: {
    listForClassification: async () => {
      orchestration.calls.push('read-notification-classification');
      return [{
        id: 'notice-1',
        title: 'Review',
        level: 'urgent',
        category: 'work',
        isActionable: true,
        connectorType: 'local',
        receivedAt: '2026-09-06T12:00:00.000Z',
      }];
    },
  },
  recommendations: {
    listAssignmentProjects: async () => [{
      id: 'project-1',
      name: 'Project One',
      description: 'Primary project',
    }],
    listAssignmentTasks: async () => [{
      id: 'task-energy',
      title: 'Deep work',
      connectorType: 'local',
      sourceListName: 'Work',
    }],
    listTagInferenceTasks: async () => [{
      id: 'task-energy',
      title: 'Deep work',
      connectorType: 'local',
      sourceListName: 'Work',
    }],
    listTaggedTaskIds: empty,
    listAvailableTagNames: async () => ['engineering'],
    listSmartPriorityTasks: async () => [{
      id: 'task-energy',
      title: 'Deep work',
      priority: 'high',
      dueDate: '2026-09-01',
      connectorType: 'local',
      sourceListName: 'Work',
      updatedAt: '2026-09-06T12:00:00.000Z',
    }],
    listMicroStatusTasks: async () => [{
      id: 'task-energy',
      title: 'Deep work',
      status: 'todo',
      microStatus: null,
      priority: 'high',
      createdAt: '2026-09-01T12:00:00.000Z',
      updatedAt: '2026-09-06T12:00:00.000Z',
      dueDate: '2026-09-01',
      connectorType: 'local',
      assignee: null,
    }],
    listWhatsNextTasks: async () => [{
      id: 'task-energy',
      title: 'Deep work',
      priority: 'high',
      dueDate: '2026-09-01',
      connectorType: 'local',
      sourceListName: 'Work',
    }],
    listWhatsNextNotifications: async () => [{ connectorType: 'local' }],
  },
  listTaskConnectorTypes: async () => ['local'],
  dayPlan: {
    listSuggestions: async () => ({
      suggestions: [{
        id: 'task-energy',
        title: 'Deep work',
        priority: 'high',
        dueDate: '2026-09-01',
        connectorType: 'local',
        reason: 'overdue' as const,
      }],
      counts: { open: 1, overdue: 1, dueToday: 0 },
    }),
  },
  taskTools: {
    getSummary: async () => ({
      total: 1,
      open: 1,
      overdue: 1,
      critical: 1,
      done: 0,
      bySource: { local: 1 },
      overdueItems: [{
        id: 'task-energy',
        title: 'Deep work',
        status: 'todo',
        microStatus: null,
        dueDate: '2026-09-01',
        priority: 'high',
        source: 'local',
      }],
    }),
    search: async () => [{
      id: 'task-energy',
      title: 'Deep work',
      status: 'todo',
      microStatus: null,
      priority: 'high',
      dueDate: '2026-09-01',
      source: 'local',
      sourceList: 'Work',
      description: null,
    }],
    listAllTags: async () => [{ id: 'tag-1', name: 'Engineering', type: 'hub', color: '#10b981' }],
    listTaskTags: async () => [{ id: 'tag-1', name: 'Engineering', type: 'hub', color: '#10b981' }],
  },
  dispatch: {
    getCustomAgentContext: async () => ({
      openTasks: [{
        id: 'task-energy',
        title: 'Deep work',
        priority: 'high',
        dueDate: '2026-09-01',
        connectorType: 'local',
      }],
      unreadNotifications: [{
        id: 'notice-1',
        title: 'Review',
        level: 'urgent',
        connectorType: 'local',
      }],
    }),
  },
  maintenance: {
    claimRun: async () => ({ claimed: true, cursor: null }),
    scanBatch: async () => [],
    commitBatch: async () => ({ applied: 0 }),
  },
  goalsBoard: {
    listGoalTasks: async () => [{
      id: 'task-energy',
      title: 'Deep work',
      description: null,
      status: 'todo',
      priority: 'high',
      dueDate: '2026-09-01',
      createdAt: '2026-09-01T12:00:00.000Z',
      updatedAt: '2026-09-06T12:00:00.000Z',
      connectorType: 'local',
      tags: [{ id: 'tag-1', name: 'Goal', slug: 'goal', color: '#10b981', type: 'hub' }],
      linkedProjects: [],
    }],
    countGoalTags: async () => ({ goal: 1, idea: 0, brainstorm: 0 }),
    promoteGoal: async (input) => (
      input.taskId === 'missing'
        ? { kind: 'not-found' as const }
        : { kind: 'promoted' as const, projectId: input.projectId, tasksCreated: ['mc-goal-1'] }
    ),
  },
  ideation: {
    convertDraft: async ({ project }) => ({ projectId: project.id }),
  },
  resets: {
    get: async () => null,
    list: async () => [],
    upsert: async ({ type, periodStart, periodEnd, now }) => ({
      id: 'reset-1',
      type,
      periodStart,
      periodEnd,
      wentWell: null,
      needsAdjustment: null,
      notes: null,
      stats: null,
      aiSummary: null,
      staleActions: [],
      carryForwardItems: [],
      monthlyWin: null,
      monthlyChange: null,
      intentions: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    }),
    patch: async () => null,
    aggregateStats: async () => ({
      completedTasks: [],
      createdTaskCount: 0,
      carriedForwardCount: 0,
      activeRoutines: [],
      periodCompletions: [],
      focusItems: [],
      staleTasks: [],
      energyData: [],
      focusTaskStatuses: [],
    }),
  },
};

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({
    aiWorkflows,
    dailyPlanning: {
      energy: { getForDate: async () => null },
      energySuggestions: {
        listTasksByIds: async () => {
          orchestration.calls.push('read-energy-tasks');
          return [{
            id: 'task-energy',
            title: 'Deep work',
            description: null,
            priority: 'high',
            connectorType: 'local',
          }];
        },
        listOpenTopLevelTasks: async () => [{
          id: 'task-energy',
          title: 'Deep work',
          description: null,
          priority: 'high',
          connectorType: 'local',
        }],
        listLevels: async () => {
          orchestration.calls.push('read-energy-levels');
          return [];
        },
        apply: async () => {
          orchestration.calls.push('atomic-apply');
          return {
            canonicalTagIds: {},
            appliedTaskIds: ['task-energy'],
          };
        },
      },
      dayPlan: {
        getContext: async () => ({
          myDayItems: [{
            id: 'task-energy',
            title: 'Deep work',
            priority: 'high',
            dueDate: '2026-09-01',
            connectorType: 'local',
          }],
          schedules: [{
            taskId: 'task-energy',
            scheduledTime: '09:00',
            estimatedDuration: 30,
          }],
          openTasks: [{
            id: 'task-energy',
            title: 'Deep work',
            priority: 'high',
            dueDate: '2026-09-01',
            connectorType: 'local',
          }],
        }),
      },
      focus: {
        getSuggestionContext: async () => ({
          focusTaskIds: [],
          myDayTaskIds: ['task-energy'],
          tasks: [{
            id: 'task-energy',
            title: 'Deep work',
            status: 'todo',
            priority: 'high',
            dueDate: '2026-09-01',
            connectorType: 'local',
            sourceListName: 'Work',
            createdAt: '2026-09-01T12:00:00.000Z',
            updatedAt: '2026-09-06T12:00:00.000Z',
            depth: 0,
          }],
        }),
      },
    },
    projectAutomation: {
      projectAdministration: {
        getProject: async (id: string) => (
          id === 'missing' ? null : {
            id,
            name: 'Project One',
            description: 'Primary project',
          }
        ),
        listPhasePlanningTaskIds: async () => ['task-energy'],
        listPhasePlanningTasks: async () => [{
          id: 'task-energy',
          title: 'Deep work',
          description: null,
          status: 'todo',
          priority: 'high',
          dueDate: '2026-09-01',
          connectorType: 'local',
          sourceListName: 'Work',
          updatedAt: '2026-09-06T12:00:00.000Z',
          tags: ['engineering'],
          projectNames: ['Project One'],
        }],
        getGoalDevelopmentContext: async (id: string) => (
          id === 'missing' ? null : {
            task: {
              id,
              title: 'Deep work',
              description: null,
              connectorType: 'local',
            },
            tags: [{ name: 'Engineering', slug: 'engineering' }],
            linkedProjects: [{
              name: 'Project One',
              description: 'Primary project',
              category: 'engineering',
            }],
            existingProjects: [{ name: 'Project One', category: 'engineering' }],
          }
        ),
      },
    },
  }),
}));

describe('poisoned-SQLite AI workflow web surface', () => {
  it('uses one repeatable-read client for digest snapshots and releases it after rollback', async () => {
    const { createPostgresAIWorkflowPersistence } = await import(
      '@/db/postgres/repositories/ai-workflow-repository'
    );
    const commands: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        commands.push(text.trim().replace(/\s+/g, ' '));
        if (text.includes('FROM tasks') && text.includes('COUNT(*)')) {
          return {
            rows: [{ open: 1, overdue: 1, dueToday: 0, inProgress: 0, critical: 1 }],
          };
        }
        if (text.includes('FROM tasks') && text.includes('due_date <')) {
          return {
            rows: [{
              id: 'task-overdue',
              title: 'Overdue',
              priority: 'high',
              dueDate: '2026-09-01',
              connectorType: 'local',
            }],
          };
        }
        if (text.includes('FROM notifications') && text.includes('COUNT(*)')) {
          return { rows: [{ unread: 1, urgent: 1 }] };
        }
        if (text.includes('FROM notifications')) {
          return {
            rows: [{
              id: 'notification-1',
              title: 'Act now',
              level: 'urgent',
              connectorType: 'local',
            }],
          };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client), query: vi.fn() };
    const snapshot = await createPostgresAIWorkflowPersistence(
      pool as never,
    ).context.loadDigestSnapshot({
      today: '2026-09-06',
      now: '2026-09-06T12:00:00.000Z',
      rowsPerCategory: 5,
    });

    expect(snapshot.overdue).toHaveLength(1);
    expect(snapshot.notifications).toHaveLength(1);
    expect(commands[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(commands.at(-1)).toBe('COMMIT');
    expect(pool.query).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledOnce();

    const failedCommands: string[] = [];
    const failedClient = {
      query: vi.fn(async (text: string) => {
        failedCommands.push(text.trim());
        if (text.trim().startsWith('SELECT')) throw new Error('read failed');
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const failedPool = { connect: vi.fn(async () => failedClient) };
    await expect(createPostgresAIWorkflowPersistence(
      failedPool as never,
    ).context.loadDigestSnapshot({
      today: '2026-09-06',
      now: '2026-09-06T12:00:00.000Z',
      rowsPerCategory: 5,
    })).rejects.toThrow('read failed');
    expect(failedCommands.at(-1)).toBe('ROLLBACK');
    expect(failedClient.release).toHaveBeenCalledOnce();
  });

  it('shares canonical task/tag locks and uses conflict-safe energy links', async () => {
    const { createPostgresAIDailyPlanningExtensions } = await import(
      '@/db/postgres/repositories/ai-workflow-repository'
    );
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text: text.trim().replace(/\s+/g, ' '), values });
        if (text.includes('SELECT id') && text.includes('FROM tasks')) {
          return { rows: [{ id: 'task-a' }, { id: 'task-z' }] };
        }
        if (text.includes('SELECT id FROM tags')) {
          return { rows: [{ id: `canonical-${String(values?.[0])}` }] };
        }
        return { rows: [], rowCount: text.includes('INSERT INTO task_tags') ? 1 : 0 };
      }),
      release: vi.fn(),
    };
    const planning = createPostgresAIDailyPlanningExtensions({
      connect: vi.fn(async () => client),
    } as never);
    await planning.energySuggestions.apply({
      definitions: [
        { slug: 'energy-low', name: 'Low', color: '#000000' },
        { slug: 'energy-high', name: 'High', color: '#10b981' },
      ],
      suggestions: [
        { taskId: 'task-z', energyLevel: 'low' },
        { taskId: 'task-a', energyLevel: 'high' },
      ],
      createdAt: '2026-09-06T12:00:00.000Z',
    });

    expect(calls.filter((call) => call.text.includes('pg_advisory_xact_lock(hashtext($1))'))
      .map((call) => call.values?.[0])).toEqual([
      'task-ancillary:task-a',
      'task-ancillary:task-z',
      'tag-slug:energy-high',
      'tag-slug:energy-low',
    ]);
    expect(calls.findIndex((call) => call.text.includes('LOCK TABLE task_tags')))
      .toBeLessThan(calls.findIndex((call) => (
        call.text.includes('SELECT id') && call.text.includes('FROM tasks')
      )));
    expect(calls.findIndex((call) => call.text.includes('tag-consolidation')))
      .toBeLessThan(calls.findIndex((call) => call.values?.[0] === 'task-ancillary:task-a'));
    expect(calls.find((call) => call.text.includes('INSERT INTO task_tags'))?.text)
      .toContain('ON CONFLICT DO NOTHING');
  });

  it('imports every PR1-clean route and library without evaluating SQLite', async () => {
    const modules = await Promise.all([
      import('@/app/api/ai/assign-projects/route'),
      import('@/app/api/ai/context-tasks/route'),
      import('@/app/api/ai/context-triage/route'),
      import('@/app/api/ai/daily-digest/route'),
      import('@/app/api/ai/infer-tags/route'),
      import('@/app/api/ai/plan-day/route'),
      import('@/app/api/ai/smart-priority/route'),
      import('@/app/api/ai/suggest-energy-tags/route'),
      import('@/app/api/ai/suggest-focus/route'),
      import('@/app/api/ai/suggest-micro-status/route'),
      import('@/app/api/ai/triage-alerts/route'),
      import('@/app/api/ai/whats-next/route'),
      import('@/app/api/goals/develop/route'),
      import('@/app/api/ideation/expand/route'),
      import('@/app/api/project-phases/ai-refine/route'),
      import('@/app/api/project-phases/ai-suggest/route'),
      import('@/app/api/resets/ai-summary/route'),
      import('@/app/api/tasks/[id]/breakdown/route'),
      import('@/lib/ai/context-budget'),
      import('@/lib/ai/features/notification-classification'),
      import('@/lib/ai/features/notification-queries'),
      import('@/lib/ai/provider-runtime'),
    ]);

    expect(modules).toHaveLength(22);
    const routes = modules.slice(0, 18) as Array<{
      GET?: unknown;
      POST?: unknown;
    }>;
    for (const route of routes) {
      expect(
        typeof route.GET === 'function' || typeof route.POST === 'function',
      ).toBe(true);
    }
  });

  it('loads notification candidates before invoking the pure classifier model', async () => {
    orchestration.calls.length = 0;
    const route = await import('@/app/api/ai/triage-alerts/route');

    const response = await route.GET();

    expect(response.status).toBe(200);
    expect(orchestration.calls).toEqual([
      'read-notification-classification',
      'load-provider-configuration',
      'model',
      'load-provider-configuration',
    ]);
  });

  it('serves deterministic non-model context and focus routes from the selected contract', async () => {
    const [tasks, triage, focus, notificationQueries] = await Promise.all([
      import('@/app/api/ai/context-tasks/route'),
      import('@/app/api/ai/context-triage/route'),
      import('@/app/api/ai/suggest-focus/route'),
      import('@/lib/ai/features/notification-queries'),
    ]);

    const taskResponse = await tasks.GET();
    expect(await taskResponse.json()).toEqual({
      overdue: [expect.objectContaining({ id: 'task-overdue' })],
      today: [],
      inProgress: [],
    });
    expect(await (await triage.GET()).json()).toEqual({
      unreadCount: 2,
      criticalCount: 1,
      categories: ['security'],
    });
    const focusResponse = await focus.POST(new Request(
      'http://localhost/api/ai/suggest-focus',
      {
        method: 'POST',
        body: JSON.stringify({ energy: 'high' }),
      },
    ));
    expect(focusResponse.status).toBe(200);
    expect((await focusResponse.json()).suggestions)
      .toEqual([expect.objectContaining({ id: 'task-energy' })]);
    await expect(notificationQueries.listNotificationsForClassification())
      .resolves.toEqual([expect.objectContaining({ id: 'notice-1' })]);
  });

  it('keeps energy persistence reads before model I/O and atomic apply after it', async () => {
    orchestration.calls.length = 0;
    const route = await import('@/app/api/ai/suggest-energy-tags/route');
    const response = await route.POST(new Request(
      'http://localhost/api/ai/suggest-energy-tags',
      {
        method: 'POST',
        body: JSON.stringify({ taskIds: ['task-energy'], autoApply: true }),
      },
    ));

    expect(response.status).toBe(200);
    expect(orchestration.calls).toEqual([
      'read-energy-levels',
      'read-energy-tasks',
      'load-provider-configuration',
      'model',
      'atomic-apply',
    ]);
  });

  it('executes every other clean route without reaching SQLite', async () => {
    const [
      assignment,
      digest,
      tags,
      plan,
      priority,
      microStatus,
      whatsNext,
      goals,
      ideation,
      refine,
      suggest,
      reset,
      breakdown,
    ] = await Promise.all([
      import('@/app/api/ai/assign-projects/route'),
      import('@/app/api/ai/daily-digest/route'),
      import('@/app/api/ai/infer-tags/route'),
      import('@/app/api/ai/plan-day/route'),
      import('@/app/api/ai/smart-priority/route'),
      import('@/app/api/ai/suggest-micro-status/route'),
      import('@/app/api/ai/whats-next/route'),
      import('@/app/api/goals/develop/route'),
      import('@/app/api/ideation/expand/route'),
      import('@/app/api/project-phases/ai-refine/route'),
      import('@/app/api/project-phases/ai-suggest/route'),
      import('@/app/api/resets/ai-summary/route'),
      import('@/app/api/tasks/[id]/breakdown/route'),
    ]);

    expect((await assignment.GET()).status).toBe(200);
    expect((await digest.GET()).status).toBe(200);
    expect((await tags.GET()).status).toBe(200);
    expect((await priority.GET()).status).toBe(200);
    expect((await microStatus.GET()).status).toBe(200);
    expect((await whatsNext.GET(new Request('http://localhost/api/ai/whats-next'))).status)
      .toBe(200);
    expect((await plan.POST(new Request('http://localhost/api/ai/plan-day', {
      method: 'POST',
      body: '{}',
    }))).status).toBe(200);
    expect((await goals.POST(new Request('http://localhost/api/goals/develop', {
      method: 'POST',
      body: JSON.stringify({ taskId: 'missing' }),
    }))).status).toBe(404);
    expect((await goals.POST(new Request('http://localhost/api/goals/develop', {
      method: 'POST',
      body: JSON.stringify({ taskId: 'task-energy' }),
    }))).status).toBe(200);

    const ideationBody = {
      selectedNode: { id: 'root', label: 'Root', kind: 'idea', parentId: null },
      contextNodes: [{
        id: 'root',
        label: 'Root',
        kind: 'idea',
        parentId: null,
        sortOrder: 0,
      }],
      contextVersion: 'version-1',
    };
    expect((await ideation.POST(new Request('http://localhost/api/ideation/expand', {
      method: 'POST',
      headers: {
        host: 'localhost',
        origin: 'http://localhost',
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify(ideationBody),
    }))).status).toBe(200);
    expect((await refine.POST(new Request('http://localhost/api/project-phases/ai-refine', {
      method: 'POST',
      body: JSON.stringify({
        projectId: 'missing',
        currentPhases: [{ name: 'Phase', taskIds: ['task'] }],
      }),
    }))).status).toBe(404);
    expect((await refine.POST(new Request('http://localhost/api/project-phases/ai-refine', {
      method: 'POST',
      body: JSON.stringify({
        projectId: 'project-1',
        currentPhases: [{ name: 'Phase', taskIds: ['task-energy'] }],
      }),
    }))).status).toBe(200);
    expect((await suggest.POST(new Request('http://localhost/api/project-phases/ai-suggest', {
      method: 'POST',
      body: '{}',
    }))).status).toBe(200);
    expect((await reset.POST(new Request('http://localhost/api/resets/ai-summary', {
      method: 'POST',
      body: JSON.stringify({ stats: {} }),
    }))).status).toBe(200);
    expect((await breakdown.POST(
      new Request('http://localhost/api/tasks/missing/breakdown', {
        method: 'POST',
        headers: {
          host: 'localhost',
          origin: 'http://localhost',
          'sec-fetch-site': 'same-origin',
        },
      }),
      { params: Promise.resolve({ id: 'missing' }) },
    )).status).toBe(404);
    expect((await breakdown.POST(
      new Request('http://localhost/api/tasks/task-energy/breakdown', {
        method: 'POST',
        headers: {
          host: 'localhost',
          origin: 'http://localhost',
          'sec-fetch-site': 'same-origin',
        },
      }),
      { params: Promise.resolve({ id: 'task-energy' }) },
    )).status).toBe(200);
  });

  it('imports every PR2 application-workflow route without evaluating SQLite', async () => {
    const modules = await Promise.all([
      import('@/app/api/ai/dispatch/route'),
      import('@/app/api/ai/route'),
      import('@/app/api/goals/promote/route'),
      import('@/app/api/goals/route'),
      import('@/app/api/ideation/convert/route'),
      import('@/app/api/resets/route'),
      import('@/app/api/resets/stats/route'),
    ]);

    expect(modules).toHaveLength(7);
    for (const route of modules as Array<{ GET?: unknown; POST?: unknown; PATCH?: unknown }>) {
      expect(
        typeof route.GET === 'function'
        || typeof route.POST === 'function'
        || typeof route.PATCH === 'function',
      ).toBe(true);
    }
  });

  it('executes the PR2 goals, ideation, and resets routes without reaching SQLite', async () => {
    const [goalsList, goalsPromote, ideationConvert, resets, resetsStats] = await Promise.all([
      import('@/app/api/goals/route'),
      import('@/app/api/goals/promote/route'),
      import('@/app/api/ideation/convert/route'),
      import('@/app/api/resets/route'),
      import('@/app/api/resets/stats/route'),
    ]);

    const goalsResponse = await goalsList.GET(
      new Request('http://localhost/api/goals'),
    );
    expect(goalsResponse.status).toBe(200);
    expect((await goalsResponse.json()).items).toEqual([
      expect.objectContaining({ id: 'task-energy' }),
    ]);

    expect((await goalsPromote.POST(new Request('http://localhost/api/goals/promote', {
      method: 'POST',
      body: JSON.stringify({ taskId: 'missing', projectName: 'Missing project' }),
    }))).status).toBe(404);
    const promoted = await goalsPromote.POST(new Request('http://localhost/api/goals/promote', {
      method: 'POST',
      body: JSON.stringify({ taskId: 'task-energy', projectName: 'Deep Work Project' }),
    }));
    expect(promoted.status).toBe(201);

    const ideationResponse = await ideationConvert.POST(new Request(
      'http://localhost/api/ideation/convert',
      {
        method: 'POST',
        body: JSON.stringify({
          name: 'Graph project',
          color: '#6366f1',
          nodes: [{
            id: 'root',
            label: 'Graph project',
            kind: 'idea',
            parentId: null,
            sortOrder: 0,
            properties: {},
          }],
        }),
      },
    ));
    expect(ideationResponse.status).toBe(201);

    const resetPost = await resets.POST(new Request('http://localhost/api/resets', {
      method: 'POST',
      body: JSON.stringify({
        type: 'weekly',
        periodStart: '2026-09-01',
        periodEnd: '2026-09-07',
      }),
    }));
    expect(resetPost.status).toBe(201);

    const resetsListResponse = await resets.GET(new Request('http://localhost/api/resets'));
    expect(resetsListResponse.status).toBe(200);

    const statsResponse = await resetsStats.GET(new Request(
      'http://localhost/api/resets/stats?type=weekly&periodStart=2026-09-01',
    ));
    expect(statsResponse.status).toBe(200);
  });

  it('serializes maintenance-agent dispatch through the claim/scan/apply contract', async () => {
    const dispatch = await import('@/app/api/ai/dispatch/route');
    const response = await dispatch.POST(new Request('http://localhost/api/ai/dispatch', {
      method: 'POST',
      body: JSON.stringify({ agent: 'cleanup-done', dryRun: true }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('success');
  });
});
