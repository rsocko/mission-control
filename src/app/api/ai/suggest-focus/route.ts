import { NextResponse } from 'next/server';
import { getLocalToday } from '@/lib/utils/date';
import { getEnergyTagsForTasks } from '@/lib/ai/features/energy-tag-queries';
import { ApiErrors } from '@/lib/api-error';
import { NEXT_7_DAYS } from '@/lib/tasks/due-window';
import { getAIDailyPlanningPersistence } from '@/lib/ai/workflow-persistence';

/**
 * Get the Monday of the week for a given YYYY-MM-DD date.
 */
function getWeekMonday(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * POST /api/ai/suggest-focus — AI suggests Focus 3 candidates
 * 
 * Uses a heuristic scoring approach (no LLM required) to rank tasks.
 * Returns up to 3 suggestions based on: priority, due date proximity,
 * My Day membership, recency, and energy-level matching.
 * 
 * Body: { scope: 'today'|'week', date?: string, energy?: 'high'|'medium'|'low' }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const scope = body.scope || 'today';
    const date = body.date || getLocalToday();
    const persistence = await getAIDailyPlanningPersistence();

    // Resolve user's current energy level: explicit param > today's check-in > default
    let userEnergy: 'high' | 'medium' | 'low' = body.energy || 'medium';
    if (!body.energy) {
      const checkin = await persistence.energy.getForDate(date);
      if (checkin) {
        userEnergy = checkin.level as 'high' | 'medium' | 'low';
      }
    }

    // Normalize date for week scope to Monday
    const effectiveDate = scope === 'week' ? getWeekMonday(date) : date;

    // Get tasks already in focus for this scope
    const suggestionContext = await persistence.focus.getSuggestionContext({
      scope,
      date,
      effectiveDate,
      taskLimit: 200,
    });
    const focusTaskIds = new Set(suggestionContext.focusTaskIds);
    const openTasks = suggestionContext.tasks;
    const myDayTaskIds = new Set(suggestionContext.myDayTaskIds);

    // Get energy demand tags for candidate tasks
    const candidateIds = openTasks.filter(t => !focusTaskIds.has(t.id)).map(t => t.id);
    const energyMap = await getEnergyTagsForTasks(candidateIds);

    const now = new Date();

    // Score each task
    const scored = openTasks
      .filter(t => !focusTaskIds.has(t.id))
      .map(t => {
        let score = 0;

        // Priority weight (highest impact)
        const priorityScores: Record<string, number> = {
          critical: 100,
          high: 70,
          medium: 40,
          low: 15,
          none: 5,
        };
        score += priorityScores[t.priority] || 5;

        // Due date proximity
        if (t.dueDate) {
          const dueDateStr = t.dueDate.split('T')[0];
          const dueDate = new Date(dueDateStr + 'T12:00:00');
          const daysUntilDue = Math.floor((dueDate.getTime() - now.getTime()) / 86400000);

          if (daysUntilDue < 0) {
            // Overdue — strong signal
            score += 80 + Math.min(Math.abs(daysUntilDue) * 5, 40);
          } else if (daysUntilDue === 0) {
            score += 70; // Due today
          } else if (daysUntilDue <= 2) {
            score += 50; // Due very soon
          } else if (daysUntilDue <= NEXT_7_DAYS) {
            score += 25; // Due in the next seven days
          }
        }

        // In My Day boost (user already planned to work on it)
        if (myDayTaskIds.has(t.id)) {
          score += 30;
        }

        // Energy matching: boost tasks whose energy demand matches user's current level
        const taskEnergy = energyMap.get(t.id);
        if (taskEnergy) {
          if (taskEnergy === userEnergy) {
            score += 25; // Perfect match
          } else if (
            (userEnergy === 'low' && taskEnergy === 'high') ||
            (userEnergy === 'high' && taskEnergy === 'low')
          ) {
            score -= 15; // Mismatch penalty
          }
          // medium↔high or medium↔low: no adjustment (close enough)
        }

        // Recently updated boost (active tasks)
        const updatedDaysAgo = Math.floor((now.getTime() - new Date(t.updatedAt).getTime()) / 86400000);
        if (updatedDaysAgo <= 1) score += 15;
        else if (updatedDaysAgo <= 3) score += 8;

        // For weekly scope, give more weight to tasks without near-term due dates
        // (weekly focus should be bigger picture items)
        if (scope === 'week' && !t.dueDate) {
          score += 10;
        }

        return { ...t, score, energyDemand: taskEnergy || null };
      })
      .sort((a, b) => b.score - a.score);

    // Return top 3 (or fewer if not enough tasks)
    const slotsNeeded = 3 - focusTaskIds.size;
    const suggestions = scored.slice(0, Math.max(slotsNeeded, 3)).map(t => ({
      id: t.id,
      title: t.title,
      priority: t.priority,
      dueDate: t.dueDate,
      connectorType: t.connectorType,
      sourceListName: t.sourceListName,
      score: t.score,
      energyDemand: t.energyDemand,
    }));

    return NextResponse.json({ suggestions, scope, date: effectiveDate, userEnergy });
  } catch (error) {
    return ApiErrors.internal('Failed to suggest focus items', error);
  }
}
