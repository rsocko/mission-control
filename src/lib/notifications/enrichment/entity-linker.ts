/**
 * Entity Linker
 *
 * Scans notification content for references to entities in our local database
 * (tasks, projects) and populates relatedTaskId/relatedProjectId fields.
 *
 * Handles:
 * - Issue/PR numbers: #123, org/repo#123
 * - Repository names matching known source lists
 * - Task titles that match notification subjects
 */

import type {
  NotificationEntityLinkingRepository,
} from '@/db/persistence/notification-entity-linking';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

// ─── TYPES ──────────────────────────────────────────────────────────────────

export interface EntityLinkResult {
  relatedTaskId: string | null;
  relatedProjectId: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  navigationTarget: string | null;
}

export interface LinkableNotification {
  title: string;
  body?: string | null;
  connectorType: string;
  connectorInstanceId: string;
  metadata: Record<string, unknown>;
  /** If already extracted by parser */
  entityNumber?: number;
  repository?: string;
}

// ─── REFERENCE EXTRACTION ───────────────────────────────────────────────────

interface ExtractedReference {
  type: 'issue' | 'pr';
  /** e.g. "owner/repo" — may be empty if bare #123 */
  repository?: string;
  number: number;
}

/**
 * Extracts issue/PR references from text.
 * Matches: #123, owner/repo#123
 */
function extractReferences(text: string): ExtractedReference[] {
  const refs: ExtractedReference[] = [];
  // Match "owner/repo#123" or bare "#123"
  const regex = /(?:([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+))?#(\d+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    refs.push({
      type: 'issue', // We can't distinguish PR vs issue from reference alone
      repository: match[1] || undefined,
      number: parseInt(match[2], 10),
    });
  }
  return refs;
}

// ─── ENTITY LOOKUP ──────────────────────────────────────────────────────────

/**
 * Finds a task in the database by its source ID pattern.
 * GitHub tasks have sourceIds like "owner/repo:123"
 */
async function findTaskBySourceReference(
  persistence: NotificationEntityLinkingRepository,
  connectorInstanceId: string,
  repository: string,
  number: number,
): Promise<{ id: string } | null> {
  return persistence.findTaskBySourceReference({
    connectorInstanceId,
    repository,
    number,
  });
}

/**
 * Finds a project ID associated with a repository.
 * Looks up hub_projects that were created from GitHub Projects for this repo.
 */
async function findProjectByRepository(
  persistence: NotificationEntityLinkingRepository,
  repository: string,
): Promise<string | null> {
  return persistence.findProjectByRepository(repository);
}

// ─── MAIN LINKER ────────────────────────────────────────────────────────────

/**
 * Attempts to link a notification to existing entities in the database.
 * Returns fields to populate on the notification record.
 */
export async function linkEntities(notification: LinkableNotification): Promise<EntityLinkResult> {
  const persistence = (
    await getWorkerPersistenceRepositories()
  ).notificationEntityLinking;
  const result: EntityLinkResult = {
    relatedTaskId: null,
    relatedProjectId: null,
    relatedEntityType: null,
    relatedEntityId: null,
    navigationTarget: null,
  };

  const repository = notification.repository ||
    (notification.metadata.repository as string | undefined);
  const entityNumber = notification.entityNumber ||
    (notification.metadata.entityNumber as number | undefined);

  // Strategy 1: Direct match via pre-extracted entity number + repo
  if (repository && entityNumber) {
    const task = await findTaskBySourceReference(
      persistence,
      notification.connectorInstanceId,
      repository,
      entityNumber,
    );

    if (task) {
      result.relatedTaskId = task.id;
      result.relatedEntityType = 'task';
      result.relatedEntityId = task.id;
      result.navigationTarget = `/tasks?selected=${task.id}`;
    }
  }

  // Strategy 2: Scan title/body for additional references
  const searchText = [notification.title, notification.body].filter(Boolean).join(' ');
  const refs = extractReferences(searchText);

  for (const ref of refs) {
    if (result.relatedTaskId) break; // Already found one

    const refRepo = ref.repository || repository;
    if (!refRepo) continue;

    const task = await findTaskBySourceReference(
      persistence,
      notification.connectorInstanceId,
      refRepo,
      ref.number,
    );

    if (task) {
      result.relatedTaskId = task.id;
      result.relatedEntityType = 'task';
      result.relatedEntityId = task.id;
      result.navigationTarget = `/tasks?selected=${task.id}`;
    }
  }

  // Strategy 3: Link to project by repository
  if (repository && !result.relatedProjectId) {
    const projectId = await findProjectByRepository(persistence, repository);
    if (projectId) {
      result.relatedProjectId = projectId;
      if (!result.navigationTarget) {
        result.navigationTarget = `/projects/${projectId}`;
      }
    }
  }

  return result;
}

// ─── BATCH HELPER ───────────────────────────────────────────────────────────

/**
 * Links entities for multiple notifications. Processes in parallel
 * with a concurrency limit to avoid overwhelming the database.
 */
export async function linkEntitiesBatch(
  notifications: LinkableNotification[],
): Promise<Map<number, EntityLinkResult>> {
  const results = new Map<number, EntityLinkResult>();
  // Process sequentially to avoid SQLite contention
  for (let i = 0; i < notifications.length; i++) {
    results.set(i, await linkEntities(notifications[i]));
  }
  return results;
}
