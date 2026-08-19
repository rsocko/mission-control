import db from '@/db';
import { tags, taskTags } from '@/db/schema';
import { and, inArray } from 'drizzle-orm';

const ENERGY_TAG_SLUGS = ['energy-high', 'energy-medium', 'energy-low'];

export async function getEnergyTagsForTasks(
  taskIds: string[],
): Promise<Map<string, 'high' | 'medium' | 'low'>> {
  if (taskIds.length === 0) return new Map();

  const energyTags = await db.select({ id: tags.id, slug: tags.slug })
    .from(tags)
    .where(inArray(tags.slug, ENERGY_TAG_SLUGS));
  if (energyTags.length === 0) return new Map();

  const energyTagIds = energyTags.map(tag => tag.id);
  const slugById = new Map(energyTags.map(tag => [tag.id, tag.slug]));
  const junctions = await db.select({ taskId: taskTags.taskId, tagId: taskTags.tagId })
    .from(taskTags)
    .where(and(
      inArray(taskTags.taskId, taskIds),
      inArray(taskTags.tagId, energyTagIds),
    ));

  const result = new Map<string, 'high' | 'medium' | 'low'>();
  for (const junction of junctions) {
    const slug = slugById.get(junction.tagId);
    if (slug === 'energy-high') result.set(junction.taskId, 'high');
    else if (slug === 'energy-medium') result.set(junction.taskId, 'medium');
    else if (slug === 'energy-low') result.set(junction.taskId, 'low');
  }
  return result;
}
