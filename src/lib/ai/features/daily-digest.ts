import { generateText } from 'ai';
import { getLocalToday } from '@/lib/utils/date';
import { aiLogger } from '@/lib/logger';
import { applyAIContextCharacterBudget, loadAIContextSnapshot } from '../context-budget';
import { getAIModel, getAIRouteOutcome } from '../provider-factory';
import type { AIRouteOutcome } from '../types';

export async function generateDailyDigest(): Promise<{ digest: string; routing: AIRouteOutcome }> {
  const today = getLocalToday();
  const snapshot = await loadAIContextSnapshot(today);
  const route = getAIModel('daily-digest', { sources: snapshot.sources });
  const context = applyAIContextCharacterBudget(`
Today: ${today} (${new Date().toLocaleDateString('en-US', { weekday: 'long' })})

TASKS:
- ${snapshot.counts.open} open tasks total
- ${snapshot.counts.overdue} overdue: ${snapshot.overdue.map(t => `"${t.title}" (due ${t.dueDate})`).join(', ')}
- ${snapshot.counts.dueToday} due today: ${snapshot.dueToday.map(t => `"${t.title}"`).join(', ')}
- ${snapshot.counts.critical} critical/high priority

NOTIFICATIONS (${snapshot.counts.unreadNotifications} unread):
${snapshot.notifications.map(a => `- [${a.level}] ${a.title}`).join('\n')}

Sources represented: ${snapshot.sources.join(', ')}
`, 'daily-digest');
  aiLogger.info({
    event: 'ai_context_rows',
    featureId: 'daily-digest',
    contextRows: snapshot.rowCount,
  }, 'Selected bounded AI context rows');

  const result = await generateText({
    model: route.model,
    system: 'You generate a concise, actionable morning briefing for a busy professional. Include: 1) Top priority items for today, 2) Overdue items needing attention, 3) Key notifications, 4) A recommended focus for the day. Use markdown formatting with headers and bullet points. Keep it under 300 words.',
    messages: [{ role: 'user', content: context }],
  });

  return {
    digest: result.text,
    routing: getAIRouteOutcome(route.context, result.response),
  };
}
