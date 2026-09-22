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
  return { ...item, title, tags };
}
