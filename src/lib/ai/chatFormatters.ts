import { getLocalToday } from '@/lib/utils/client-date';
import { fetchAllTasks } from '@/lib/tasks/fetch-all';
import { needsAttention } from '@/lib/notifications/lifecycle';

export function formatToolDate(value: unknown) {
  if (!value || typeof value !== 'string') return 'no due date';

  const datePart = value.split('T')[0];
  const [y, m, d] = datePart.split('-').map(Number);
  if (!y || !m || !d) return value;

  const date = new Date(y, m - 1, d);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date);
}

export function formatInlineInput(value: unknown) {
  if (!value || typeof value !== 'object') return 'none';
  return Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined && entry !== null && entry !== '')
    .map(([key, entry]) => `${key}: ${String(entry)}`)
    .join(', ');
}

export function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export async function readJsonSafely(response: Response) {
  try {
    return await response.json() as { error?: string; fallback?: boolean };
  } catch {
    return null;
  }
}

export function formatResult(json: string): string {
  try {
    const data = JSON.parse(json);

    if (data.digest) return data.digest;
    if (data.recommendation) return data.recommendation;
    if (data.rankings) {
      return data.rankings.map((ranking: { title: string; score: number; reason: string }, index: number) =>
        `${index + 1}. [${ranking.score}] ${ranking.title}\n   → ${ranking.reason}`,
      ).join('\n\n');
    }
    if (data.suggestions && data.suggestions[0]?.suggestedTags) {
      return data.suggestions.map((suggestion: { title: string; suggestedTags: string[]; confidence: number }) =>
        `• "${suggestion.title}"\n  Tags: ${suggestion.suggestedTags.join(', ')} (${Math.round(suggestion.confidence * 100)}%)`,
      ).join('\n\n');
    }
    if (data.actions) {
      return data.actions.map((action: { title: string; recommendation: string; reason: string }) =>
        `${action.recommendation === 'act_now' ? '🔴' : action.recommendation === 'schedule' ? '🟡' : '⚪'} ${action.title}\n  → ${action.recommendation}: ${action.reason}`,
      ).join('\n\n');
    }
    if (data.assignments) {
      return data.assignments.map((assignment: { title: string; projectName: string; confidence: number }) =>
        `• "${assignment.title}" → ${assignment.projectName} (${Math.round(assignment.confidence * 100)}%)`,
      ).join('\n');
    }

    return json;
  } catch {
    return json;
  }
}

export async function getLocalFallback(query: string): Promise<string> {
  try {
    const [allTasks, notificationsRes] = await Promise.all([
      fetchAllTasks<{
        status: string;
        dueDate: string | null;
        priority: string;
        title: string;
        connectorType: string;
      }>('/api/tasks?parentOnly=true'),
      fetch('/api/notifications'),
    ]);
    const notificationsData = await notificationsRes.json();
    const allNotifications = notificationsData.items || notificationsData.notifications || [];
    const today = getLocalToday();
    const open = allTasks.filter((task: { status: string }) => task.status !== 'done' && task.status !== 'cancelled');
    const overdue = open.filter((task: { dueDate: string | null }) => task.dueDate && task.dueDate < today);
    const critical = open.filter((task: { priority: string }) => task.priority === 'critical' || task.priority === 'high');
    const unreadNotifications = allNotifications.filter((notification: {
      state?: string;
      readState?: string;
      disposition?: string;
      sourceState?: string;
      snoozedUntil?: string | null;
      level?: string | null;
    }) => needsAttention(notification));
    const q = query.toLowerCase();

    if (q.includes('overdue')) {
      return overdue.length === 0
        ? "🎉 No overdue tasks! You're all caught up."
        : `⚠️ You have **${overdue.length} overdue task(s)**:\n\n${overdue.map((task) => `• **${task.title}** (due ${task.dueDate}, ${task.priority} priority)`).join('\n')}`;
    }

    if (q.includes('summary') || q.includes('summarize')) {
      return `📊 **Task Summary**\n\n• **${open.length}** open tasks (${allTasks.length} total)\n• **${overdue.length}** overdue\n• **${critical.length}** critical/high priority\n• **${unreadNotifications.length}** unread notifications\n\nSources: ${[...new Set(allTasks.map((task: { connectorType: string }) => task.connectorType))].join(', ')}`;
    }

    if (q.includes('plan') || q.includes('day') || q.includes('focus') || q.includes('next')) {
      const suggestions = [...overdue, ...critical].slice(0, 5);
      return suggestions.length === 0
        ? '✅ No urgent items! You could tackle low-priority items or work on a project.'
        : `📋 **Suggested Focus for Today:**\n\n${suggestions.map((task: { title: string; dueDate: string | null; priority: string }, index: number) => `${index + 1}. **${task.title}** — ${task.dueDate && task.dueDate < today ? '⚠️ OVERDUE' : `${task.priority} priority`}`).join('\n')}\n\nStart with #1 — it's the most urgent.`;
    }

    if (q.includes('critical') || q.includes('urgent') || q.includes('important')) {
      return critical.length === 0
        ? 'No critical or high-priority items right now.'
        : `🔥 **Critical/High Priority Items (${critical.length}):**\n\n${critical.map((task: { title: string; dueDate: string | null; connectorType: string }) => `• **${task.title}** ${task.dueDate ? `(due ${task.dueDate})` : ''} — via ${task.connectorType}`).join('\n')}`;
    }

    return `📊 Quick stats: **${open.length}** open tasks, **${overdue.length}** overdue, **${unreadNotifications.length}** unread notifications.\n\nI'm running in local fallback mode. Connect to your Ollama instance for full AI-powered analysis.`;
  } catch {
    return "I couldn't fetch your task data. Make sure the API is running.";
  }
}
