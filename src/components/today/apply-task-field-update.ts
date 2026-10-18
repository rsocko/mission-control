import type { TaskFieldUpdate } from '@/components/task-detail/task-detail-types';
import type { MyDayItem, SuggestionTask } from './types';

function applySharedTaskFieldUpdate<T extends MyDayItem | SuggestionTask>(
  item: T,
  fields: TaskFieldUpdate,
): T {
  return {
    ...item,
    ...(typeof fields.title === 'string' ? { title: fields.title } : {}),
    ...(typeof fields.status === 'string' ? { status: fields.status } : {}),
    ...(typeof fields.priority === 'string' ? { priority: fields.priority } : {}),
    ...(fields.planningHorizon === null || typeof fields.planningHorizon === 'string'
      ? { planningHorizon: fields.planningHorizon as MyDayItem['planningHorizon'] }
      : {}),
    ...(fields.dueDate === null || typeof fields.dueDate === 'string'
      ? { dueDate: fields.dueDate }
      : {}),
    ...(fields.microStatus === null || typeof fields.microStatus === 'string'
      ? { microStatus: fields.microStatus }
      : {}),
    ...(fields.localDisposition === 'active'
      || fields.localDisposition === 'handled'
      || fields.localDisposition === 'dismissed'
      ? { localDisposition: fields.localDisposition }
      : {}),
  };
}

export function applyMyDayTaskFieldUpdate(
  item: MyDayItem,
  taskId: string,
  fields: TaskFieldUpdate,
): MyDayItem {
  if (item.taskId !== taskId) return item;

  const tagIds = fields.tagIds;
  const tags = Array.isArray(tagIds)
    ? item.tags.filter((tag) => tagIds.includes(tag.id))
    : item.tags;
  return {
    ...applySharedTaskFieldUpdate(item, fields),
    tags,
    ...(fields.statusReason === null
      || fields.statusReason === 'duplicate'
      || fields.statusReason === 'completed'
      || fields.statusReason === 'not_planned'
      || fields.statusReason === 'moved'
      ? { statusReason: fields.statusReason }
      : {}),
    ...(fields.effort === null || typeof fields.effort === 'number'
      ? { effort: fields.effort }
      : {}),
    ...(fields.estimatedDuration === null || typeof fields.estimatedDuration === 'number'
      ? { estimatedDuration: fields.estimatedDuration }
      : {}),
  };
}

export function applySuggestionTaskFieldUpdate(
  task: SuggestionTask,
  taskId: string,
  fields: TaskFieldUpdate,
): SuggestionTask {
  return task.id === taskId ? applySharedTaskFieldUpdate(task, fields) : task;
}

export function shouldRefreshMyDayAfterTaskDetailUpdate(
  fields?: TaskFieldUpdate,
): boolean {
  return fields === undefined;
}
