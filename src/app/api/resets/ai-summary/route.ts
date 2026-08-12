import { NextResponse } from 'next/server';
import { getAIModel, getAIRouteOutcome, getResolvedAIConfig } from '@/lib/ai';
import { aiLogger } from '@/lib/logger';
import db from '@/db';
import { tasks } from '@/db/schema';
import { inArray } from 'drizzle-orm';

/**
 * POST /api/resets/ai-summary — Generate an AI weekly/monthly narrative
 * Body: { stats: ResetStats } (the object returned from /api/resets/stats)
 */
export async function POST(request: Request) {
  const body = await request.json();
  const { stats } = body;

  if (!stats) {
    return NextResponse.json({ error: 'stats object is required' }, { status: 400 });
  }

  const config = getResolvedAIConfig();
  if (!config.configured) {
    return NextResponse.json(
      { error: 'AI provider not configured. Set up in Settings → AI.' },
      { status: 503 },
    );
  }

  const type = stats.type || 'weekly';
  const isMonthly = type === 'monthly';

  const staleList = (stats.staleTasks || [])
    .map((t: { title: string; daysSinceUpdate: number }) => `- "${t.title}" (${t.daysSinceUpdate} days stale)`)
    .join('\n');

  const energySummary = (stats.energyData || [])
    .map((e: { date: string; level: string }) => `${e.date}: ${e.level}`)
    .join(', ');
  const staleTaskIds = (stats.staleTasks || [])
    .map((task: { id?: string }) => task.id)
    .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
  const staleTaskSources = staleTaskIds.length > 0
    ? await db
        .select({ connectorType: tasks.connectorType })
        .from(tasks)
        .where(inArray(tasks.id, staleTaskIds))
    : [];

  const weeklyBreakdownText = isMonthly && stats.weeklyBreakdown
    ? stats.weeklyBreakdown
        .map((w: { weekStart: string; completed: number; routinePercent: number }) =>
          `Week of ${w.weekStart}: ${w.completed} completed, ${w.routinePercent}% routines`)
        .join('\n')
    : '';

  const prompt = isMonthly
    ? `Generate a monthly reflection summary for this person's productivity data.

Period: ${stats.periodStart} to ${stats.periodEnd}
Tasks completed: ${stats.tasksCompleted}
Tasks created: ${stats.tasksCreated}
Tasks carried forward: ${stats.tasksCarriedForward}
Routine adherence: ${stats.routinePercentage}%
Focus 3 hit rate: ${stats.focusHitRate}
${staleList ? `Stale tasks:\n${staleList}` : 'No stale tasks.'}
${energySummary ? `Energy levels: ${energySummary}` : ''}
Week-by-week breakdown:
${weeklyBreakdownText}`
    : `Generate a weekly reflection summary for this person's productivity data.

Period: ${stats.periodStart} to ${stats.periodEnd}
Tasks completed: ${stats.tasksCompleted}
Tasks created: ${stats.tasksCreated}
Tasks carried forward: ${stats.tasksCarriedForward}
Routine adherence: ${stats.routinePercentage}%
Focus 3 hit rate: ${stats.focusHitRate}
${staleList ? `Stale tasks:\n${staleList}` : 'No stale tasks.'}
${energySummary ? `Energy levels: ${energySummary}` : ''}`;

  const systemPrompt = `You are a productivity coach generating a ${type} summary for a personal task management system. The user has ADHD-friendly needs — be encouraging but honest.

Write in second person ("You focused on..."). Be specific about the data. Structure your response as JSON with:
- "narrative": A 2-3 sentence summary paragraph (use <strong> tags for emphasis on key insights)
- "momentum": One insight about positive momentum (1-2 sentences)
- "attention": One area needing attention (1-2 sentences), or null if everything looks good
- "suggestion": One actionable suggestion (1-2 sentences)

Keep it warm, direct, and actionable. Don't be generic — reference the actual numbers.
Return only valid JSON, no markdown fences.`;

  try {
    const { generateText } = await import('ai');
    const route = getAIModel('reset-summary', {
      sources: staleTaskSources.map((task) => task.connectorType),
    });

    const result = await generateText({
      model: route.model,
      system: systemPrompt,
      prompt,
      maxOutputTokens: 500,
    });

    let parsed;
    try {
      // Strip markdown fences if model wraps response
      const cleanText = result.text.replace(/^```(?:json)?\n?/g, '').replace(/\n?```$/g, '').trim();
      parsed = JSON.parse(cleanText);
    } catch {
      // If not valid JSON, wrap the text as narrative
      parsed = {
        narrative: result.text,
        momentum: null,
        attention: null,
        suggestion: null,
      };
    }

    return NextResponse.json({
      summary: parsed,
      routing: getAIRouteOutcome(route.context, result.response),
    });
  } catch (error) {
    aiLogger.error({ err: error }, 'AI summary error');
    return NextResponse.json(
      { error: 'Failed to generate AI summary' },
      { status: 500 },
    );
  }
}
