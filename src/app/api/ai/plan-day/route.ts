import { getAIModel, getAIRouteOutcome } from '@/lib/ai';
import { generateText } from 'ai';
import db from '@/db';
import { tasks, myDayItems, taskSchedules } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { getLocalToday } from '@/lib/utils/date';
import { aiLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';

/**
 * POST /api/ai/plan-day
 * AI generates a full day plan: time-blocks tasks based on priority, duration, energy, and calendar gaps.
 * Body: { date?, calendarEvents?, preferences? }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const date = body.date || getLocalToday();

    // Gather context
    const myDayItemsData = await db
      .select({
        taskId: myDayItems.taskId,
        title: tasks.title,
        priority: tasks.priority,
        dueDate: tasks.dueDate,
        connectorType: tasks.connectorType,
      })
      .from(myDayItems)
      .innerJoin(tasks, eq(myDayItems.taskId, tasks.id))
      .where(eq(myDayItems.date, date));

    const existingSchedule = await db
      .select()
      .from(taskSchedules)
      .where(eq(taskSchedules.scheduledDate, date));

    // Get high-priority tasks not yet in My Day
    const openTasks = await db.select().from(tasks).where(eq(tasks.status, 'todo')).limit(20);
    const highPriTasks = openTasks.filter(t => t.priority === 'critical' || t.priority === 'high');

    const calendarEvents = body.calendarEvents || [];
    const energy = body.energy || 'medium';
    const workStartHour = body.preferences?.workStartHour || 9;
    const workEndHour = body.preferences?.workEndHour || 17;
    const focusBlockMinutes = body.preferences?.focusBlockMinutes || 90;

    const context = `
Today: ${date}
Energy level: ${energy}
Work hours: ${workStartHour}:00 - ${workEndHour}:00
Focus block preference: ${focusBlockMinutes} minutes

Calendar events (blocked time):
${calendarEvents.length > 0
  ? calendarEvents.map((e: { subject: string; startTime: string; endTime: string; duration: number }) =>
      `- ${e.startTime}-${e.endTime}: ${e.subject} (${e.duration}min)`
    ).join('\n')
  : '- No calendar events'}

My Day tasks (${myDayItemsData.length}):
${myDayItemsData.map(t => `- "${t.title}" [${t.priority}]${t.dueDate ? ` due ${t.dueDate}` : ''}`).join('\n') || '- None added yet'}

Already scheduled:
${existingSchedule.map(s => `- ${s.scheduledTime || '?'}: taskId ${s.taskId} (${s.estimatedDuration || 30}min)`).join('\n') || '- None'}

Other high-priority tasks (not in My Day):
${highPriTasks.slice(0, 5).map(t => `- "${t.title}" [${t.priority}]${t.dueDate ? ` due ${t.dueDate}` : ''}`).join('\n') || '- None'}
`;

    const route = getAIModel('day-planning', {
      sources: [
        ...openTasks.map((task) => task.connectorType),
        ...myDayItemsData.map((task) => task.connectorType),
        ...(calendarEvents.length > 0 ? ['outlook-calendar'] : []),
      ],
    });

    const result = await generateText({
      model: route.model,
      system: `You are a personal productivity planner. Create an optimal day schedule by:
1. Respecting calendar events (immovable blocks)
2. Scheduling high-priority and overdue tasks in morning focus blocks
3. Grouping similar tasks together
4. Leaving breaks between focus blocks
5. Adapting to energy level: if "high" → front-load demanding/creative work; if "low" → schedule lighter tasks, shorter blocks, more breaks; if "medium" → balanced approach
6. Putting lower-energy tasks in the afternoon

Respond with a JSON object in this exact format:
{
  "plan": [
    { "time": "09:00", "endTime": "09:30", "type": "calendar", "title": "...", "duration": 30 },
    { "time": "09:30", "endTime": "11:00", "type": "task", "title": "...", "taskId": "...", "duration": 90 },
    { "time": "11:00", "endTime": "11:15", "type": "break", "title": "Break", "duration": 15 }
  ],
  "summary": "Brief 1-line summary of the plan",
  "suggestions": ["optional suggestion 1", "optional suggestion 2"]
}

Only include tasks that are in the My Day list or high-priority tasks you're recommending to add. Use "type" values: "calendar", "task", "break", "focus".`,
      messages: [{ role: 'user', content: `Plan my day:\n${context}` }],
    });

    // Parse the AI response
    let plan;
    try {
      // Extract JSON from the response (may be wrapped in markdown)
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      plan = jsonMatch ? JSON.parse(jsonMatch[0]) : { plan: [], summary: 'Could not parse plan', suggestions: [] };
    } catch {
      plan = { plan: [], summary: result.text.slice(0, 200), suggestions: [] };
    }

    return Response.json({
      ...plan,
      generatedAt: new Date().toISOString(),
      date,
      routing: getAIRouteOutcome(route.context, result.response),
    });
  } catch (error) {
    aiLogger.error({ err: error }, 'Plan day request failed');
    return ApiErrors.internal('Failed to plan day', error);
  }
}
