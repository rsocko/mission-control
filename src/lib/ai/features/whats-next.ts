import { generateText } from 'ai';
import { getLocalToday } from '@/lib/utils/date';
import {
  getAsyncAIModel,
  getAsyncAIRouteOutcome,
} from '../provider-runtime';
import type { AIRouteOutcome } from '../types';
import { getEnergyTagsForTasks } from './energy-tag-queries';
import { getAIWorkflowPersistence } from '../workflow-persistence';

export async function whatsNext(context?: {
  timeAvailable?: number;
  energy?: 'high' | 'medium' | 'low';
  focus?: string;
}): Promise<{ recommendation: string; routing: AIRouteOutcome }> {
  const today = getLocalToday();
  const persistence = await getAIWorkflowPersistence();
  const openTasks = await persistence.recommendations.listWhatsNextTasks(20);
  const unreadNotifications = await persistence.recommendations
    .listWhatsNextNotifications(new Date().toISOString(), 5);
  const overdue = openTasks.filter(task => task.dueDate && task.dueDate < today);
  const critical = openTasks.filter(task => (
    task.priority === 'critical' || task.priority === 'high'
  ));
  const energyMap = await getEnergyTagsForTasks(openTasks.map(task => task.id));
  const route = await getAsyncAIModel('whats-next', {
    sources: [
      ...openTasks.map(task => task.connectorType),
      ...unreadNotifications.map(notification => notification.connectorType),
    ],
  });
  const taskContext = `
Available time: ${context?.timeAvailable || 'flexible'} minutes
Energy level: ${context?.energy || 'medium'}
Focus area: ${context?.focus || 'any'}
Today: ${today}

Overdue (${overdue.length}): ${overdue.slice(0, 3).map(task => `"${task.title}" (due ${task.dueDate})`).join(', ')}
Critical (${critical.length}): ${critical.slice(0, 3).map(task => `"${task.title}"`).join(', ')}
Open tasks: ${openTasks.length} total
Unread notifications: ${unreadNotifications.length}

Top tasks by source:
${openTasks.slice(0, 10).map(task => `- "${task.title}" [${task.priority}] via ${task.connectorType}${energyMap.has(task.id) ? ` (energy: ${energyMap.get(task.id)})` : ''}`).join('\n')}
`;
  const result = await generateText({
    model: route.model,
    system: 'You are a "what\'s next" advisor. Given the user\'s context (time, energy, focus), recommend 1-3 specific next actions. Match task energy demands to the user\'s current energy level — suggest low-energy tasks when energy is low, high-energy tasks when energy is high. Be direct and actionable. Format as a short numbered list with brief reasoning.',
    messages: [{ role: 'user', content: taskContext }],
  });

  return {
    recommendation: result.text,
    routing: getAsyncAIRouteOutcome(route, result.response),
  };
}
