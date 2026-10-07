import type { TaskFieldUpdate } from '@/components/task-detail/task-detail-types';
import type { MyDayItem } from './types';

export function applyMyDayTaskFieldUpdate(
  item: MyDayItem,
  taskId: string,
  fields: TaskFieldUpdate,
): MyDayItem {
  if (item.taskId !== taskId) return item;

  const title = typeof fields.title === 'string' ? fields.title : item.title;
  const tagIds = fields.tagIds;
  const tags = Array.isArray(tagIds)
    ? item.tags.filter((tag) => tagIds.includes(tag.id))
    : item.tags;
  return {
    ...item,
    title,
    tags,
    ...(typeof fields.status === 'string' ? { status: fields.status } : {}),
    ...(fields.statusReason === null
      || fields.statusReason === 'duplicate'
      || fields.statusReason === 'completed'
      || fields.statusReason === 'not_planned'
      || fields.statusReason === 'moved'
      ? { statusReason: fields.statusReason }
      : {}),
    ...(typeof fields.priority === 'string' ? { priority: fields.priority } : {}),
    ...(fields.planningHorizon === null || typeof fields.planningHorizon === 'string'
      ? { planningHorizon: fields.planningHorizon as MyDayItem['planningHorizon'] }
      : {}),
    ...(fields.dueDate === null || typeof fields.dueDate === 'string'
      ? { dueDate: fields.dueDate }
      : {}),
    ...(fields.effort === null || typeof fields.effort === 'number'
      ? { effort: fields.effort }
      : {}),
    ...(fields.estimatedDuration === null || typeof fields.estimatedDuration === 'number'
      ? { estimatedDuration: fields.estimatedDuration }
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
