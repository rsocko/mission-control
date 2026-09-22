import { NextResponse } from 'next/server';
import { computeSmartScore, type PriorityEntity, type SourceRanking } from '@/lib/smart-score';
import type { TaskPriority } from '@/types';
import { getResolvedPriorityEntities } from '@/lib/priority-entities';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import { NEXT_7_DAYS } from '@/lib/tasks/due-window';

/**
 * GET /api/tasks/quick-sort/suggestions?taskIds=id1,id2,...
 *
 * Returns suggestions for priority, effort, and tags for the given task IDs.
 * Uses SmartScore for priority, title heuristics for effort, and tag frequency
 * analysis for tags. No LLM calls — fast and deterministic.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const taskIdsParam = searchParams.get('taskIds');

  if (!taskIdsParam) {
    return NextResponse.json({ error: 'taskIds required' }, { status: 400 });
  }

  const taskIds = taskIdsParam.split(',').slice(0, 50);
  const { taskReads } = await getTaskCorePersistence();
  const {
    tasks: taskRows,
    sourceRankings: rankings,
    tags: allTags,
    taskTags: allTaskTags,
  } = await taskReads.getQuickSortSuggestionInputs(taskIds);

  if (taskRows.length === 0) {
    return NextResponse.json({ suggestions: {} });
  }

  // Fetch priority entities and source rankings for SmartScore
  const entities = await getResolvedPriorityEntities() as PriorityEntity[];

  // Tag frequency map
  const tagFrequency = new Map<string, number>();
  for (const tt of allTaskTags) {
    tagFrequency.set(tt.tagId, (tagFrequency.get(tt.tagId) ?? 0) + 1);
  }
  const tagsByFrequency = allTags
    .map((t) => ({ ...t, frequency: tagFrequency.get(t.id) ?? 0 }))
    .sort((a, b) => b.frequency - a.frequency);

  const suggestions: Record<
    string,
    {
      priority: { value: string; confidence: number; reason: string } | null;
      effort: { value: number; confidence: number; reason: string } | null;
      tags: Array<{ id: string; name: string; confidence: number }>;
    }
  > = {};

  for (const task of taskRows) {
    const scored = computeSmartScore(
      {
        taskId: task.id,
        title: task.title,
        priority: task.priority as TaskPriority,
        dueDate: task.dueDate,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        connectorType: task.connectorType,
        connectorInstanceId: task.connectorInstanceId,
        linkedEntityNames: [],
        personText: [task.title, task.description, task.assignee].filter((text): text is string => Boolean(text)),
        linkedEntityRefs: [],
        snoozedUntil: task.snoozedUntil,
        effort: task.effort,
      },
      entities,
      rankings as SourceRanking[],
    );

    // Priority suggestion — use title heuristics and smart score together
    let suggestedPriority: (typeof suggestions)[string]['priority'] = null;
    if (task.priority === 'none') {
      const titleLower = task.title.toLowerCase();

      // Title-based priority heuristics (stronger signal than SmartScore for unfiled tasks)
      const criticalKeywords = /\b(urgent|asap|critical|emergency|blocked|blocker|outage|down|broken|p0)\b/i;
      const highKeywords = /\b(important|deadline|overdue|bug|issue|regression|security|p1)\b/i;
      const mediumKeywords = /\b(should|review|follow.?up|improve|update|p2)\b/i;

      if (criticalKeywords.test(titleLower)) {
        suggestedPriority = { value: 'critical', confidence: 0.75, reason: 'Urgency keywords detected' };
      } else if (highKeywords.test(titleLower)) {
        suggestedPriority = { value: 'high', confidence: 0.65, reason: 'Importance keywords detected' };
      } else if (mediumKeywords.test(titleLower)) {
        suggestedPriority = { value: 'medium', confidence: 0.55, reason: 'Moderate priority keywords' };
      } else {
        // Fall back to SmartScore — but use adjusted thresholds for unfiled tasks
        // (since priority=none removes 20pts from the score, shift thresholds down)
        const score = scored.score.total;
        if (score >= 50) {
          suggestedPriority = { value: 'critical', confidence: 0.7, reason: 'High urgency score' };
        } else if (score >= 35) {
          suggestedPriority = { value: 'high', confidence: 0.6, reason: 'Above-average urgency' };
        } else if (score >= 20) {
          suggestedPriority = { value: 'medium', confidence: 0.5, reason: 'Moderate urgency' };
        } else if (score >= 10) {
          suggestedPriority = { value: 'low', confidence: 0.4, reason: 'Low urgency score' };
        } else {
          // Very low score — don't suggest anything rather than always suggesting low
          suggestedPriority = null;
        }
      }

      // Due-date override: if there's a due date approaching, bump the suggestion
      if (task.dueDate) {
        const daysUntilDue = (new Date(task.dueDate).getTime() - Date.now()) / 86400000;
        if (daysUntilDue < 0 && (!suggestedPriority || suggestedPriority.value !== 'critical')) {
          suggestedPriority = { value: 'critical', confidence: 0.8, reason: 'Overdue task' };
        } else if (daysUntilDue <= 2 && (!suggestedPriority || suggestedPriority.value === 'low' || suggestedPriority.value === 'medium')) {
          suggestedPriority = { value: 'high', confidence: 0.7, reason: 'Due very soon' };
        } else if (daysUntilDue <= NEXT_7_DAYS && (!suggestedPriority || suggestedPriority.value === 'low')) {
          suggestedPriority = { value: 'medium', confidence: 0.6, reason: 'Due in the next 7 days' };
        }
      }
    }

    // Effort suggestion based on title keyword heuristics
    let suggestedEffort: (typeof suggestions)[string]['effort'] = null;
    if (task.effort === null) {
      const titleLower = task.title.toLowerCase();
      if (/\b(fix|typo|rename|bump|update dep|hotfix)\b/i.test(titleLower)) {
        suggestedEffort = { value: 1, confidence: 0.6, reason: 'Quick fix keywords' };
      } else if (/\b(refactor|redesign|architect|migration|overhaul)\b/i.test(titleLower)) {
        suggestedEffort = { value: 4, confidence: 0.5, reason: 'Large effort keywords' };
      } else if (/\b(add|create|implement|build|setup|set up)\b/i.test(titleLower)) {
        suggestedEffort = { value: 3, confidence: 0.4, reason: 'Implementation keywords' };
      }
    }

    // Tag suggestions: title keyword match → fallback to most frequent
    const existingTaskTagIds = new Set(
      allTaskTags.filter((tt) => tt.taskId === task.id).map((tt) => tt.tagId)
    );
    const suggestedTags: Array<{ id: string; name: string; confidence: number }> = [];

    if (existingTaskTagIds.size === 0) {
      const titleLower = task.title.toLowerCase();
      const sourceListLower = (task.sourceListName ?? '').toLowerCase();
      const seenTagNames = new Set<string>();

      for (const tag of tagsByFrequency.slice(0, 30)) {
        if (existingTaskTagIds.has(tag.id)) continue;
        const tagLower = tag.name.toLowerCase();
        // Skip duplicate tag names (DB can have same-name tags with different IDs)
        if (seenTagNames.has(tagLower)) continue;
        if (titleLower.includes(tagLower) || sourceListLower.includes(tagLower)) {
          suggestedTags.push({ id: tag.id, name: tag.name, confidence: 0.7 });
          seenTagNames.add(tagLower);
        }
      }

      // Fallback: top 2 by frequency with low confidence
      if (suggestedTags.length === 0 && tagsByFrequency.length > 0) {
        for (const tag of tagsByFrequency.slice(0, 2)) {
          const tagLower = tag.name.toLowerCase();
          if (seenTagNames.has(tagLower)) continue;
          suggestedTags.push({ id: tag.id, name: tag.name, confidence: 0.3 });
          seenTagNames.add(tagLower);
        }
      }
    }

    suggestions[task.id] = {
      priority: suggestedPriority,
      effort: suggestedEffort,
      tags: suggestedTags.slice(0, 3),
    };
  }

  return NextResponse.json({ suggestions });
}
