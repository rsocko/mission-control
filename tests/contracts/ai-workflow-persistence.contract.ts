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

    it('exposes bounded task-tools summary, search, and tag reads', async () => {
      const { persistence } = harness();
      const summary = await persistence.taskTools.getSummary({
        today: AI_WORKFLOW_TODAY,
        overdueLimit: 5,
      });
      expect(summary.total).toBeGreaterThanOrEqual(6);
      expect(summary.overdueItems.some((item) => item.id === 'aiw-task-a')).toBe(true);

      const searched = await persistence.taskTools.search({ query: 'Alpha', limit: 5 });
      expect(searched.map((task) => task.id)).toEqual(['aiw-task-a']);

      const allTags = await persistence.taskTools.listAllTags();
      expect(allTags.some((tag) => tag.name === 'Alpha')).toBe(true);

      const taskTags = await persistence.taskTools.listTaskTags('aiw-task-a');
      expect(taskTags.map((tag) => tag.name)).toEqual(['Alpha']);
    });

    it('bounds the dispatch custom-agent context to open tasks and unread notifications', async () => {
      const { persistence } = harness();
      const context = await persistence.dispatch.getCustomAgentContext({
        taskLimit: 2,
        notificationLimit: 2,
      });
      expect(context.openTasks.length).toBeLessThanOrEqual(2);
      expect(context.unreadNotifications.length).toBeLessThanOrEqual(2);
    });

    it('converts an ideation draft atomically and lists/promotes goals through the adapter', async () => {
      const { persistence } = harness();
      const projectId = `aiw-ideation-project-${backend.toLowerCase()}`;
      const taskId = `aiw-ideation-task-${backend.toLowerCase()}`;
      const converted = await persistence.ideation.convertDraft({
        project: { id: projectId, name: 'Ideation project', color: '#3b82f6', metadata: {} },
        phases: [],
        tasks: [{
          id: taskId,
          title: 'Draft goal',
          description: null,
          status: 'todo',
          priority: 'none',
          assignee: null,
          dueDate: null,
          parentId: null,
          depth: 0,
          metadata: {},
          effort: null,
          tagNames: ['goal'],
        }],
        phaseItems: [],
        dependencies: [],
        now: AI_WORKFLOW_NOW,
      });
      expect(converted).toEqual({ projectId });

      const goalTasks = await persistence.goalsBoard.listGoalTasks({
        tagSlugs: ['goal'],
        projectId: null,
      });
      expect(goalTasks.map((task) => task.id)).toContain(taskId);
      const counts = await persistence.goalsBoard.countGoalTags();
      expect(counts.goal).toBeGreaterThanOrEqual(1);

      const promotedProjectId = `aiw-promoted-${backend.toLowerCase()}`;
      const promotion = await persistence.goalsBoard.promoteGoal({
        taskId: 'aiw-task-a',
        projectId: promotedProjectId,
        projectName: 'Promoted project',
        projectDescription: null,
        category: null,
        color: '#10b981',
        phases: [{
          name: 'Phase 1',
          description: null,
          tasks: [{ title: 'Do it', description: null }],
        }],
        now: AI_WORKFLOW_NOW,
      });
      expect(promotion).toEqual({
        kind: 'promoted',
        projectId: promotedProjectId,
        tasksCreated: [expect.any(String)],
      });

      await expect(persistence.goalsBoard.promoteGoal({
        taskId: 'aiw-task-missing',
        projectId: `aiw-promoted-missing-${backend.toLowerCase()}`,
        projectName: 'Missing',
        projectDescription: null,
        category: null,
        color: '#10b981',
        phases: [],
        now: AI_WORKFLOW_NOW,
      })).resolves.toEqual({ kind: 'not-found' });
    });

    it('runs the maintenance claim/scan/apply/finish contract with per-agent-type serialization', async () => {
      const { persistence } = harness();
      const claim = await persistence.maintenance.claimRun({
        runId: 'aiw-run-1',
        agentType: 'cleanup-done',
        dryRun: false,
        cursor: null,
        leaseExpiresAt: '2026-09-06T13:00:00.000Z',
        startedAt: AI_WORKFLOW_NOW,
      });
      expect(claim).toEqual({ claimed: true, cursor: null });

      const overlapping = await persistence.maintenance.claimRun({
        runId: 'aiw-run-2',
        agentType: 'cleanup-done',
        dryRun: false,
        cursor: null,
        leaseExpiresAt: '2026-09-06T13:00:00.000Z',
        startedAt: AI_WORKFLOW_NOW,
      });
      expect(overlapping.claimed).toBe(false);

      const unrelatedAgent = await persistence.maintenance.claimRun({
        runId: 'aiw-run-unrelated',
        agentType: 'bulk-prioritize',
        dryRun: false,
        cursor: null,
        leaseExpiresAt: '2026-09-06T13:00:00.000Z',
        startedAt: AI_WORKFLOW_NOW,
      });
      expect(unrelatedAgent.claimed).toBe(true);

      const rows = await persistence.maintenance.scanBatch({
        agentType: 'cleanup-done',
        cursor: null,
        limit: 101,
        now: AI_WORKFLOW_NOW,
      });
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.find((row) => row.id === 'aiw-task-d')).toMatchObject({ eligible: false });

      // A row that is not (or is no longer) eligible must never be mutated on
      // the strength of a scan, and must not be counted as work performed.
      const committed = await persistence.maintenance.commitBatch({
        runId: 'aiw-run-1',
        agentType: 'cleanup-done',
        ids: ['aiw-task-d'],
        now: AI_WORKFLOW_NOW,
        completedAt: AI_WORKFLOW_NOW,
        status: 'succeeded',
        checkpoint: null,
        scanned: rows.length,
        hasMore: false,
      });
      expect(committed).toEqual({ applied: 0 });
      const afterCommit = await persistence.context.listTaskContext();
      expect(afterCommit.find((task) => task.id === 'aiw-task-d')?.status).toBe('done');

      const resumed = await persistence.maintenance.claimRun({
        runId: 'aiw-run-3',
        agentType: 'cleanup-done',
        dryRun: false,
        cursor: null,
        leaseExpiresAt: '2026-09-06T13:05:00.000Z',
        startedAt: '2026-09-06T12:05:00.000Z',
      });
      expect(resumed.claimed).toBe(true);
    });

    it('supports typed reset get/list/upsert/patch plus aggregate stats', async () => {
      const { persistence } = harness();
      const created = await persistence.resets.upsert({
        type: 'weekly',
        periodStart: '2026-08-31',
        periodEnd: '2026-09-06',
        now: AI_WORKFLOW_NOW,
        fields: { wentWell: 'Shipped a feature', staleActions: [], carryForwardItems: [] },
      });
      expect(created.wentWell).toBe('Shipped a feature');
      expect(created.type).toBe('weekly');

      const fetched = await persistence.resets.get('weekly', '2026-08-31');
      expect(fetched?.id).toBe(created.id);

      const listed = await persistence.resets.list('weekly', 10);
      expect(listed.map((reset) => reset.id)).toContain(created.id);

      const patched = await persistence.resets.patch(created.id, {
        notes: 'Patched note',
      }, AI_WORKFLOW_NOW);
      expect(patched?.notes).toBe('Patched note');

      const stats = await persistence.resets.aggregateStats({
        periodStart: '2026-09-01',
        periodEnd: '2026-09-06',
        periodStartIso: '2026-09-01T00:00:00.000Z',
        periodEndExclusiveIso: '2026-09-07T00:00:00.000Z',
        staleThresholdExclusiveIso: '2026-08-23T00:00:00.000Z',
        staleLimit: 10,
      });
      expect(Array.isArray(stats.completedTasks)).toBe(true);
      expect(Array.isArray(stats.staleTasks)).toBe(true);
      expect(Array.isArray(stats.activeRoutines)).toBe(true);
    });

    it('preserves omitted reset fields on upsert while honouring an explicit null', async () => {
      const { persistence } = harness();
      const periodStart = '2026-08-24';
      const seeded = await persistence.resets.upsert({
        type: 'weekly',
        periodStart,
        periodEnd: '2026-08-30',
        now: AI_WORKFLOW_NOW,
        fields: {
          wentWell: 'Kept',
          needsAdjustment: null,
          notes: 'Original note',
          stats: null,
          aiSummary: null,
          staleActions: ['keep-me'],
          carryForwardItems: [],
          monthlyWin: null,
          monthlyChange: null,
          intentions: null,
          completedAt: null,
        },
      });
      expect(seeded.wentWell).toBe('Kept');

      const partiallyUpdated = await persistence.resets.upsert({
        type: 'weekly',
        periodStart,
        periodEnd: '2026-08-30',
        now: AI_WORKFLOW_NOW,
        fields: { notes: 'Updated note' },
      });
      expect(partiallyUpdated.id).toBe(seeded.id);
      expect(partiallyUpdated.notes).toBe('Updated note');
      expect(partiallyUpdated.wentWell).toBe('Kept');
      expect(partiallyUpdated.staleActions).toEqual(['keep-me']);

      const cleared = await persistence.resets.upsert({
        type: 'weekly',
        periodStart,
        periodEnd: '2026-08-30',
        now: AI_WORKFLOW_NOW,
        fields: { wentWell: null },
      });
      expect(cleared.wentWell).toBeNull();
      expect(cleared.notes).toBe('Updated note');
      expect(cleared.staleActions).toEqual(['keep-me']);

      const patched = await persistence.resets.patch(
        seeded.id,
        { notes: null },
        AI_WORKFLOW_NOW,
      );
      expect(patched?.notes).toBeNull();
      expect(patched?.staleActions).toEqual(['keep-me']);
    });

    it('returns bounded day-plan candidates with exact open/overdue totals', async () => {
      const { persistence } = harness();
      const plan = await persistence.dayPlan.listSuggestions({
        today: AI_WORKFLOW_TODAY,
        limit: 5,
      });

      expect(plan.suggestions.map((task) => task.id)).toEqual(['aiw-task-a', 'aiw-task-b']);
      expect(plan.suggestions.map((task) => task.reason)).toEqual(['overdue', 'due-today']);
      expect(plan.counts).toEqual({ open: 4, overdue: 1, dueToday: 1 });

      const bounded = await persistence.dayPlan.listSuggestions({
        today: AI_WORKFLOW_TODAY,
        limit: 1,
      });
      expect(bounded.suggestions.map((task) => task.id)).toEqual(['aiw-task-a']);
      // The totals stay exact even when the row budget truncates the list.
      expect(bounded.counts).toEqual({ open: 4, overdue: 1, dueToday: 1 });
    });
  });
}
