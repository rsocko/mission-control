import type {
  TaskQuickSortSuggestionInputs,
  TaskQuickSortSuggestionTask,
} from '@/lib/tasks/core/contracts';

export interface TagRecommendation {
  id: string;
  name: string;
  confidence: number;
  reason: string;
}

interface RecommendationSignal {
  confidence: number;
  reason: string;
}

const MIN_CONTEXTUAL_CONFIDENCE = 0.45;
const MAX_RECOMMENDATIONS = 3;

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokenize(value: string): Set<string> {
  return new Set(
    normalize(value)
      .split(' ')
      .filter((token) => token.length > 2),
  );
}

function textContainsPhrase(text: string, phrase: string): boolean {
  const normalizedText = ` ${normalize(text)} `;
  const normalizedPhrase = normalize(phrase);
  return Boolean(normalizedPhrase) && normalizedText.includes(` ${normalizedPhrase} `);
}

function titleSimilarity(left: string, right: string): number {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return overlap / Math.min(leftTokens.size, rightTokens.size);
}

function uniqueTaskCount(
  rows: TaskQuickSortSuggestionInputs['taskTags'],
): number {
  return new Set(rows.map((row) => row.taskId)).size;
}

function recencyBoost(updatedAt: string, now: Date): number {
  const ageMs = now.getTime() - new Date(updatedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return 0;
  const ageDays = ageMs / 86_400_000;
  if (ageDays <= 14) return 0.05;
  if (ageDays <= 45) return 0.03;
  if (ageDays <= 120) return 0.01;
  return 0;
}

function bestSignal(signals: RecommendationSignal[]): RecommendationSignal | null {
  return signals.sort((left, right) => right.confidence - left.confidence)[0] ?? null;
}

export function recommendTagsForTask(
  task: TaskQuickSortSuggestionTask,
  inputs: Pick<TaskQuickSortSuggestionInputs, 'tags' | 'taskTags' | 'projectAffinities'>,
  now = new Date(),
): TagRecommendation[] {
  const existingTaskTagIds = new Set(
    inputs.taskTags
      .filter((row) => row.taskId === task.id)
      .map((row) => row.tagId),
  );
  if (existingTaskTagIds.size > 0) return [];

  const peerAssignments = inputs.taskTags.filter((row) => (
    row.taskId !== task.id
    && row.connectorInstanceId === task.connectorInstanceId
  ));
  const listAssignments = task.sourceListId
    ? peerAssignments.filter((row) => row.sourceListId === task.sourceListId)
    : [];
  const listTaskCount = uniqueTaskCount(listAssignments);
  const sourceTaskCount = uniqueTaskCount(peerAssignments);

  const projectIdsByTask = new Map<string, Set<string>>();
  for (const affinity of inputs.projectAffinities) {
    if (!affinity.projectId) continue;
    const projectIds = projectIdsByTask.get(affinity.taskId) ?? new Set<string>();
    projectIds.add(affinity.projectId);
    projectIdsByTask.set(affinity.taskId, projectIds);
  }
  const dominantProjectTasks = new Map<string, Set<string>>();
  const projectCohort = listTaskCount >= 2 ? listAssignments : peerAssignments;
  for (const assignment of projectCohort) {
    for (const projectId of projectIdsByTask.get(assignment.taskId) ?? []) {
      const projectTasks = dominantProjectTasks.get(projectId) ?? new Set<string>();
      projectTasks.add(assignment.taskId);
      dominantProjectTasks.set(projectId, projectTasks);
    }
  }
  const dominantProjectId = [...dominantProjectTasks.entries()]
    .sort((left, right) => right[1].size - left[1].size)[0]?.[0];

  const seenTagNames = new Set<string>();
  return inputs.tags
    .filter((tag) => !existingTaskTagIds.has(tag.id))
    .map((tag): TagRecommendation | null => {
      const signals: RecommendationSignal[] = [];
      if (textContainsPhrase(task.title, tag.name)) {
        signals.push({ confidence: 0.92, reason: 'Tag name appears in the task title' });
      } else if (task.description && textContainsPhrase(task.description, tag.name)) {
        signals.push({ confidence: 0.82, reason: 'Tag name appears in the task description' });
      } else if (task.sourceListName && textContainsPhrase(task.sourceListName, tag.name)) {
        signals.push({ confidence: 0.78, reason: 'Tag matches the source list' });
      }

      const tagAssignments = peerAssignments.filter((row) => row.tagId === tag.id);
      const tagListAssignments = listAssignments.filter((row) => row.tagId === tag.id);
      const tagListTaskCount = uniqueTaskCount(tagListAssignments);
      const tagSourceTaskCount = uniqueTaskCount(tagAssignments);
      const newestTagUse = tagAssignments
        .map((row) => row.updatedAt)
        .sort((left, right) => right.localeCompare(left))[0];
      const recentBoost = newestTagUse ? recencyBoost(newestTagUse, now) : 0;

      if (listTaskCount >= 2 && tagListTaskCount > 0) {
        const share = tagListTaskCount / listTaskCount;
        if (tagListTaskCount >= 2 || share >= 0.5) {
          signals.push({
            confidence: Math.min(0.79, 0.5 + share * 0.24 + recentBoost),
            reason: `Used on ${tagListTaskCount} of ${listTaskCount} tagged tasks in ${task.sourceListName ?? 'this list'}`,
          });
        }
      } else if (sourceTaskCount >= 3 && tagSourceTaskCount >= 2) {
        const share = tagSourceTaskCount / sourceTaskCount;
        if (share >= 0.2) {
          signals.push({
            confidence: Math.min(0.69, 0.44 + share * 0.2 + recentBoost),
            reason: `Common on similar tasks from this source`,
          });
        }
      }

      const similarAssignments = tagAssignments
        .map((row) => ({ row, similarity: titleSimilarity(task.title, row.title) }))
        .filter(({ similarity }) => similarity >= 0.34)
        .sort((left, right) => right.similarity - left.similarity);
      if (similarAssignments.length > 0) {
        const similarity = similarAssignments[0].similarity;
        signals.push({
          confidence: Math.min(0.78, 0.5 + similarity * 0.25 + recentBoost),
          reason: 'Used on a similarly named task',
        });
      }

      if (dominantProjectId) {
        const projectUses = tagAssignments.filter((row) => (
          projectIdsByTask.get(row.taskId)?.has(dominantProjectId)
        )).length;
        if (projectUses >= 2) {
          signals.push({
            confidence: Math.min(0.72, 0.52 + projectUses * 0.04 + recentBoost),
            reason: 'Common in the likely project for this task',
          });
        }
      }

      const signal = bestSignal(signals);
      if (!signal || signal.confidence < MIN_CONTEXTUAL_CONFIDENCE) return null;
      return {
        id: tag.id,
        name: tag.name,
        confidence: Number(signal.confidence.toFixed(2)),
        reason: signal.reason,
      };
    })
    .filter((recommendation): recommendation is TagRecommendation => Boolean(recommendation))
    .sort((left, right) => (
      right.confidence - left.confidence
      || left.name.localeCompare(right.name)
    ))
    .filter((recommendation) => {
      const name = normalize(recommendation.name);
      if (seenTagNames.has(name)) return false;
      seenTagNames.add(name);
      return true;
    })
    .slice(0, MAX_RECOMMENDATIONS);
}
