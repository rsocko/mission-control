/**
 * Document Intelligence triage action write-back.
 * Handles complete_action and defer_action by patching the DI action queue.
 */

import type { TriageItem } from '@/types';
import { connectorRegistry } from '@/lib/connectors';
import type { DocumentIntelligenceConnector } from '@/lib/connectors/document-intelligence';
import logger from '@/lib/logger';

/**
 * Resolve the DI connector instance for a triage item.
 * Returns null if the item isn't from document-intelligence or no connector is configured.
 */
function resolveDIConnector(item: TriageItem): DocumentIntelligenceConnector | null {
  if (item.sourcePlatform !== 'document-intelligence') return null;

  const connectorInstanceId = item.rawMetadata?.connectorInstanceId as string | undefined;
  if (!connectorInstanceId) return null;

  const connector = connectorRegistry.getConnector(connectorInstanceId);
  if (!connector || connector.type !== 'document-intelligence') return null;

  return connector as DocumentIntelligenceConnector;
}

/**
 * Write back a complete_action to the DI action queue (marks action as 'done').
 */
export async function completeDocumentAction(item: TriageItem): Promise<{ success: boolean; error?: string }> {
  const connector = resolveDIConnector(item);
  if (!connector) {
    // No connector available — record the action locally but skip write-back
    logger.warn({ triageItemId: item.id }, 'DI connector not available for complete_action write-back');
    return { success: true };
  }

  try {
    await connector.completeTask(item.sourceId);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, triageItemId: item.id, sourceId: item.sourceId }, 'Failed to write back complete_action to DI');
    return { success: false, error: message };
  }
}

export async function reopenDocumentAction(item: TriageItem): Promise<void> {
  const connector = resolveDIConnector(item);
  if (!connector) {
    throw new Error('OWL connector is unavailable');
  }
  await connector.reopenTask(item.sourceId);
}

/**
 * Write back a defer_action to the DI action queue.
 * DI doesn't have a native "defer" concept — we mark it as snoozed locally only.
 * No external write-back needed.
 */
export async function deferDocumentAction(item: TriageItem): Promise<{ success: boolean; error?: string }> {
  // Defer is a local-only operation (snooze in triage) — no DI write-back
  logger.info({ triageItemId: item.id, sourceId: item.sourceId }, 'Document action deferred (local snooze)');
  return { success: true };
}
