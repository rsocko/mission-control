/**
 * Document Intelligence importer for triage queue.
 *
 * Fetches pending actions from the DI action-queue API and ingests them
 * into the triage system with deduplication via ingestTriageImport().
 */
import { ingestTriageImport } from '../capture';
import { upsertSyncState } from '../sync-state';
import type { TriageImportSummary, FullSyncResult } from './base-importer';
import { fetchWithRateLimit, IMPORT_USER_AGENT } from './base-importer';
import {
  isActionReady,
  resolveActionCta,
  resolveReviewUrl,
  type DocAction,
} from '@/lib/connectors/document-intelligence/document-parser';

export interface DocIntelligenceImportOptions {
  baseUrl?: string;
  apiKey?: string;
  paperlessBaseUrl?: string;
}

const DEFAULT_DI_URL = 'http://localhost:8200';

/**
 * Resolve DI connection settings from env vars.
 */
export function resolveDocIntelligenceSettings(): DocIntelligenceImportOptions {
  const baseUrl = (process.env.DOC_INTELLIGENCE_URL || DEFAULT_DI_URL).replace(/\/$/, '');
  const apiKey = process.env.DOC_INTELLIGENCE_API_KEY || undefined;
  const paperlessBaseUrl = process.env.PAPERLESS_BASE_URL?.replace(/\/$/, '') || undefined;
  return { baseUrl, apiKey, paperlessBaseUrl };
}

/**
 * Import pending DI actions into the triage queue (single fetch, no pagination).
 */
export async function importDocumentIntelligenceActions(
  options?: DocIntelligenceImportOptions,
): Promise<TriageImportSummary> {
  const settings = options || resolveDocIntelligenceSettings();
  const baseUrl = (settings.baseUrl || 'http://localhost:8200').replace(/\/$/, '');

  const url = new URL(`${baseUrl}/api/action-queue/actions`);
  url.searchParams.set('status', 'pending');

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': IMPORT_USER_AGENT,
  };
  if (settings.apiKey) {
    headers['Authorization'] = `Bearer ${settings.apiKey}`;
  }

  const response = await fetchWithRateLimit(url, { headers });

  if (!response.ok) {
    throw new Error(
      `OWL import failed: ${response.status} ${response.statusText}`,
    );
  }

  const actions = (await response.json()) as DocAction[];
  const summary: TriageImportSummary = {
    imported: 0,
    skipped: 0,
    errors: [],
  };

  for (const action of actions) {
    if (!action.id || !action.document_title) {
      summary.skipped += 1;
      summary.errors.push(`Skipped DI action missing id or document_title`);
      continue;
    }
    if (!isActionReady(action)) {
      summary.skipped += 1;
      continue;
    }

    const documentUrl =
      action.document_url ||
      (settings.paperlessBaseUrl
        ? `${settings.paperlessBaseUrl}/documents/${action.document_id}/details`
        : '');
    const primaryAction = resolveActionCta(action);

    const result = await ingestTriageImport({
      sourcePlatform: 'document-intelligence',
      sourceId: `docintel-action-${action.id}`,
      sourceUrl: documentUrl,
      canonicalUrl: documentUrl,
      title: buildTitle(action),
      description: action.summary,
      capturedAt: action.created_at || undefined,
      rawMetadata: {
        actionType: action.action_type,
        amount: action.amount,
        correspondent: action.correspondent,
        documentId: action.document_id,
        documentTitle: action.document_title,
        urgency: action.urgency,
        dueDate: action.due_date,
        category: action.category,
        actionReady: isActionReady(action),
        reviewState: action.review_state,
        reviewUrl: resolveReviewUrl(action, null),
        primaryActionId: primaryAction?.id,
        primaryActionLabel: primaryAction?.label,
        primaryActionUrl: primaryAction?.url,
        connectorType: 'document-intelligence',
      },
    });

    if (result.status === 'imported') {
      summary.imported += 1;
    } else {
      summary.skipped += 1;
    }
  }

  return summary;
}

/**
 * Full sync: fetch all pending actions and ingest them.
 * DI doesn't paginate its action-queue, so this is a single-pass operation.
 */
export async function importAllDocumentIntelligenceActions(
  options?: DocIntelligenceImportOptions & { incremental?: boolean },
): Promise<FullSyncResult> {
  const startTime = Date.now();
  const result: FullSyncResult = {
    imported: 0,
    skipped: 0,
    errors: [],
    pagesProcessed: 0,
    durationMs: 0,
    lastCursor: null,
  };

  try {
    const summary = await importDocumentIntelligenceActions(options);
    result.pagesProcessed = 1;
    result.imported = summary.imported;
    result.skipped = summary.skipped;
    result.errors = summary.errors;
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }

  result.durationMs = Date.now() - startTime;

  await upsertSyncState('document-intelligence', {
    lastCursor: null,
    imported: result.imported,
    skipped: result.skipped,
    errors: result.errors.slice(0, 20),
    durationMs: result.durationMs,
  });

  return result;
}

function buildTitle(action: DocAction): string {
  switch (action.action_type) {
    case 'pay':
      if (action.correspondent && typeof action.amount === 'number') {
        return `Pay: ${action.correspondent} — $${action.amount.toFixed(2)}`;
      }
      return `Pay: ${action.document_title}`;
    case 'respond':
      return `Respond to: ${action.correspondent || action.document_title}`;
    case 'sign':
      return `Sign: ${action.document_title}`;
    case 'schedule':
      return `Schedule: ${action.document_title}`;
    case 'file':
      return `File: ${action.document_title}`;
    case 'archive':
      return `Archive: ${action.document_title}`;
    case 'review':
      return `Review: ${action.document_title}`;
    default:
      return action.document_title;
  }
}
