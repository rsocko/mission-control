import { beforeEach, describe, expect, it } from 'vitest';
import type { AIWorkflowPersistence } from '@/db/persistence/ai-workflows';
import type { DailyPlanningPersistence } from '@/db/persistence/daily-planning';
import type { ProjectAdministrationPersistence } from '@/db/persistence/project-organization';

export const AI_WORKFLOW_TODAY = '2026-09-06';
export const AI_WORKFLOW_NOW = '2026-09-06T12:00:00.000Z';
export const AI_WORKFLOW_ENERGY_DEFINITIONS = [
  { slug: 'energy-high', name: 'Energy: High', color: '#10b981' },
  { slug: 'energy-medium', name: 'Energy: Medium', color: '#f59e0b' },
  { slug: 'energy-low', name: 'Energy: Low', color: '#ef4444' },
] as const;

export interface AIWorkflowContractHarness {
  persistence: AIWorkflowPersistence;
  dailyPlanning: DailyPlanningPersistence;
  projects: ProjectAdministrationPersistence;
  reset(): Promise<void>;
  seed(): Promise<void>;
  inspectEnergyState(taskIds: readonly string[]): Promise<{
    tags: Array<{ id: string; slug: string }>;
    links: Array<{ taskId: string; tagId: string; slug: string }>;
  }>;
}

export function describeAIWorkflowPersistenceContract(
  backend: string,
  harness: () => AIWorkflowContractHarness,
) {
  describe(`${backend} AI workflow persistence contract`, () => {
    beforeEach(async () => {
      await harness().reset();
      await harness().seed();
    });

    it('preserves digest filters, limits, and explicit priority/date ordering', async () => {
      const snapshot = await harness().persistence.context.loadDigestSnapshot({
        today: AI_WORKFLOW_TODAY,
        now: AI_WORKFLOW_NOW,
        rowsPerCategory: 2,
      });

      expect(snapshot.counts).toEqual({
        open: 5,
        overdue: 2,
        dueToday: 1,
        inProgress: 1,
        critical: 2,
        unreadNotifications: 2,
        urgentNotifications: 1,
      });
      expect(snapshot.overdue.map((task) => task.id)).toEqual(['aiw-task-c', 'aiw-task-a']);
      expect(snapshot.dueToday.map((task) => task.id)).toEqual(['aiw-task-b']);
      expect(snapshot.inProgress.map((task) => task.id)).toEqual(['aiw-task-c']);
      expect(snapshot.notifications.map((notification) => notification.id))
        .toEqual(['aiw-notification-old', 'aiw-notification-new']);
      expect(snapshot.sources).toEqual(['todo', 'github', 'outlook']);
      expect(snapshot.rowCount).toBe(6);
    });

    it('keeps notification attention filtering and newest-first classification order', async () => {
      const classification = await harness().persistence.notifications
        .listForClassification(AI_WORKFLOW_NOW, 2);
      expect(classification.map((notification) => notification.id)).toEqual([
        'aiw-notification-new',
        'aiw-notification-old',
      ]);
      expect(classification.map((notification) => notification.isActionable))
        .toEqual([false, true]);

      await expect(
        harness().persistence.context.getTriageContext(AI_WORKFLOW_NOW),
      ).resolves.toMatchObject({
        unreadCount: 2,
        criticalCount: 1,
      });
    });

    it('preserves bounded recommendation ordering and requested phase/task order', async () => {
      const smart = await harness().persistence.recommendations.listSmartPriorityTasks(3);
      expect(smart.map((task) => task.id)).toEqual([
        'aiw-task-child',
        'aiw-task-e',
        'aiw-task-b',
      ]);

      const selectedEnergy = await harness().dailyPlanning.energySuggestions!
        .listTasksByIds([
          'aiw-task-e',
          'aiw-task-a',
          'aiw-task-e',
          'missing',
          'aiw-task-b',
        ], 3);
      expect(selectedEnergy.map((task) => task.id)).toEqual(['aiw-task-e', 'aiw-task-a']);

      const phaseTasks = await harness().projects
        .listPhasePlanningTasks!(['aiw-task-b', 'aiw-task-a']);
      expect(phaseTasks.map((task) => task.id)).toEqual(['aiw-task-b', 'aiw-task-a']);
      expect(phaseTasks[1]).toMatchObject({
        tags: ['Alpha'],
        projectNames: ['Project One'],
      });

      const classifications = await harness().dailyPlanning.energySuggestions!
        .listLevels(['aiw-task-b']);
      expect(classifications).toEqual([{ taskId: 'aiw-task-b', energyLevel: 'high' }]);
    });

    it('serves every AI workflow projection with non-empty deterministic fixtures', async () => {
      const { persistence, dailyPlanning, projects } = harness();
      await expect(persistence.context.listTaskContext()).resolves.not.toHaveLength(0);
      await expect(persistence.recommendations.listAssignmentProjects())
        .resolves.toEqual([expect.objectContaining({ id: 'aiw-project-1' })]);
      await expect(persistence.recommendations.listAssignmentTasks(2))
        .resolves.toEqual([
          expect.objectContaining({ id: 'aiw-task-a' }),
          expect.objectContaining({ id: 'aiw-task-b' }),
        ]);
      await expect(persistence.recommendations.listTagInferenceTasks(1))
        .resolves.toEqual([expect.objectContaining({ id: 'aiw-task-a' })]);
      await expect(persistence.recommendations.listTaggedTaskIds())
        .resolves.toEqual(expect.arrayContaining(['aiw-task-a', 'aiw-task-b']));
      await expect(persistence.recommendations.listAvailableTagNames())
        .resolves.toEqual(expect.arrayContaining(['Alpha', 'Energy high canonical']));
      await expect(persistence.recommendations.listMicroStatusTasks(2))
        .resolves.toEqual([
          expect.objectContaining({ id: 'aiw-task-a' }),
          expect.objectContaining({ id: 'aiw-task-b' }),
        ]);
      await expect(persistence.recommendations.listWhatsNextTasks(2))
        .resolves.toEqual([
          expect.objectContaining({ id: 'aiw-task-a' }),
          expect.objectContaining({ id: 'aiw-task-b' }),
        ]);
      await expect(persistence.recommendations.listWhatsNextNotifications(
        AI_WORKFLOW_NOW,
        2,
      )).resolves.toHaveLength(2);
      await expect(dailyPlanning.energySuggestions!.listOpenTopLevelTasks(2))
        .resolves.toEqual([
          expect.objectContaining({ id: 'aiw-task-a' }),
          expect.objectContaining({ id: 'aiw-task-b' }),
        ]);
      await expect(projects.listPhasePlanningTaskIds!('aiw-project-1'))
        .resolves.toEqual(expect.arrayContaining(['aiw-task-a', 'aiw-task-b']));
      await expect(projects.listPhasePlanningTaskIds!(null))
        .resolves.not.toHaveLength(0);

      const breakdown = await persistence.getTaskBreakdownContext('aiw-task-a');
      expect(breakdown).toEqual({
        task: expect.objectContaining({
          id: 'aiw-task-a',
          title: 'Alpha',
          effort: null,
          updatedAt: '2026-09-06T10:00:00.000Z',
        }),
        tagNames: ['Alpha'],
        projectNames: ['Project One'],
        subtaskTitles: ['Child'],
      });
    });

    it('keeps day-planning, focus, goal, and reset projections narrow', async () => {
      const dayPlan = await harness().dailyPlanning.dayPlan!.getContext({
        date: AI_WORKFLOW_TODAY,
        openTaskLimit: 20,
      });
      expect(dayPlan.myDayItems)
        .toEqual([expect.objectContaining({ id: 'aiw-task-b', title: 'Beta' })]);
      expect(dayPlan.schedules).toEqual([{
          taskId: 'aiw-task-b',
          scheduledTime: '09:30',
          estimatedDuration: 45,
        }]);
      await expect(
        harness().dailyPlanning.focus.getSuggestionContext!({
          scope: 'today',
          date: AI_WORKFLOW_TODAY,
          effectiveDate: AI_WORKFLOW_TODAY,
          taskLimit: 20,
        }),
      ).resolves.toMatchObject({ focusTaskIds: ['aiw-task-a'] });
      expect((await harness().dailyPlanning.focus.getSuggestionContext!({
        scope: 'today',
        date: AI_WORKFLOW_TODAY,
        effectiveDate: AI_WORKFLOW_TODAY,
        taskLimit: 20,
      })).tasks
        .map((task) => task.id)).not.toContain('aiw-task-child');

      await expect(harness().projects.getGoalDevelopmentContext!('aiw-task-a', 20))
        .resolves.toEqual({
          task: {
            id: 'aiw-task-a',
            title: 'Alpha',
            description: 'Alpha description',
            connectorType: 'github',
          },
          tags: [{ name: 'Alpha', slug: 'alpha' }],
          linkedProjects: [{
            name: 'Project One',
            description: 'First project',
            category: 'engineering',
          }],
          existingProjects: [{
            name: 'Project One',
            category: 'engineering',
          }],
        });
      expect((await harness().persistence.listTaskConnectorTypes([
        'aiw-task-a',
        'aiw-task-b',
      ])).sort()).toEqual(['github', 'todo']);
    });

    it('serializes canonical energy tag creation and applies one link per task', async () => {
      const suggestions = [
        { taskId: 'aiw-task-e', energyLevel: 'high' as const },
        { taskId: 'aiw-task-e', energyLevel: 'low' as const },
        { taskId: 'aiw-task-c', energyLevel: 'medium' as const },
        { taskId: 'aiw-task-missing', energyLevel: 'low' as const },
      ];

      const outcomes = await Promise.all(Array.from({ length: 6 }, () => (
        harness().dailyPlanning.energySuggestions!.apply({
          definitions: AI_WORKFLOW_ENERGY_DEFINITIONS,
          suggestions,
          createdAt: AI_WORKFLOW_NOW,
        })
      )));
      expect(outcomes.every((outcome) => (
        !outcome.appliedTaskIds.includes('aiw-task-missing')
      ))).toBe(true);

      const state = await harness().inspectEnergyState([
        'aiw-task-e',
        'aiw-task-c',
        'aiw-task-missing',
      ]);
      expect(state.tags.filter((tag) => tag.slug === 'energy-high').map((tag) => tag.id))
        .toEqual(['aiw-energy-a', 'aiw-energy-z']);
      expect(state.tags.filter((tag) => tag.slug === 'energy-medium')).toHaveLength(1);
      expect(state.tags.filter((tag) => tag.slug === 'energy-low')).toHaveLength(1);
      expect(state.links.filter((link) => link.taskId === 'aiw-task-e')).toEqual([{
        taskId: 'aiw-task-e',
        tagId: 'aiw-energy-a',
        slug: 'energy-high',
      }]);
      expect(state.links.filter((link) => link.taskId === 'aiw-task-c')).toHaveLength(1);
      expect(state.links.find((link) => link.taskId === 'aiw-task-c')?.slug)
        .toBe('energy-medium');
    });

    it('rolls back canonical tag creation when an energy link cannot be written', async () => {
      await expect(harness().dailyPlanning.energySuggestions!.apply({
        definitions: [
          AI_WORKFLOW_ENERGY_DEFINITIONS[1],
          {
            slug: null,
            name: 'Invalid',
            color: '#000000',
          } as unknown as (typeof AI_WORKFLOW_ENERGY_DEFINITIONS)[number],
        ],
        suggestions: [],
        createdAt: AI_WORKFLOW_NOW,
      })).rejects.toThrow();

      const state = await harness().inspectEnergyState(['aiw-task-e']);
      expect(state.tags.some((tag) => tag.slug === 'energy-medium')).toBe(false);
      expect(state.tags.some((tag) => tag.slug === 'energy-low')).toBe(false);
      expect(state.links).toEqual([]);
    });

    it('returns stable empty projections and not-found outcomes', async () => {
      await harness().reset();

      await expect(harness().persistence.context.loadDigestSnapshot({
        today: AI_WORKFLOW_TODAY,
        now: AI_WORKFLOW_NOW,
        rowsPerCategory: 5,
      })).resolves.toEqual({
        counts: {
          open: 0,
          overdue: 0,
          dueToday: 0,
          inProgress: 0,
          critical: 0,
          unreadNotifications: 0,
          urgentNotifications: 0,
        },
        overdue: [],
        dueToday: [],
        inProgress: [],
        notifications: [],
        sources: [],
        rowCount: 0,
      });
      await expect(harness().dailyPlanning.dayPlan!.getContext({
        date: AI_WORKFLOW_TODAY,
        openTaskLimit: 20,
      })).resolves.toEqual({
        myDayItems: [],
        schedules: [],
        openTasks: [],
      });
      await expect(harness().projects.getGoalDevelopmentContext!('missing', 20))
        .resolves.toBeNull();
      await expect(harness().persistence.getTaskBreakdownContext('missing'))
        .resolves.toBeNull();
    });
  });
}
