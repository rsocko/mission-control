/**
 * Notification Enrichment Pipeline
 *
 * Orchestrates the three-stage enrichment process:
 * 1. Source-specific parsing (rule-based, per connector)
 * 2. Entity linking (DB lookups for related tasks/projects)
 * 3. AI enrichment (optional async pass for summaries/suggestions)
 *
 * The pipeline transforms raw InboundNotifications from connectors into rich,
 * actionable notifications with structured metadata and entity links.
 */

import type { InboundNotification } from '@/types';
import {
  createFallbackPresentation,
  registerDefaultNotificationProviders,
  resolveNotificationProvider,
} from '@/lib/notifications/providers';
import type { NotificationActionDraft } from '@/lib/notifications/providers';
import { linkEntities } from './entity-linker';
import type { EntityLinkResult } from './entity-linker';
import { enrichWithAI, shouldEnrichWithAI } from './ai-enrichment';
import type { AIEnrichmentInput, AIEnrichmentResult } from './ai-enrichment';
import { connectorLogger } from '@/lib/logger';

// ─── TYPES ──────────────────────────────────────────────────────────────────

export interface EnrichedAlert {
  /** Original alert data (for fields not overridden) */
  original: InboundNotification;

  /** Enriched title (human-friendly) */
  title: string;
  /** Enriched body */
  body: string | null;
  /** Template key for rendering */
  templateKey: string | null;
  /** Enriched category */
  category: string;

  /** Structured presentation metadata */
  presentation: Record<string, unknown>;
  /** Actions defined by the source provider/signature */
  actions: NotificationActionDraft[];
  /** Whether the event requires user action, independent of navigational CTAs */
  isActionable: boolean;
  /** Provider signature used to interpret this notification */
  providerSignature: string | null;
  /** Full metadata (original + enrichment) */
  metadata: Record<string, unknown>;

  /** Entity links */
  relatedTaskId: string | null;
  relatedProjectId: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  navigationTarget: string | null;

  /** AI enrichment (may be null if skipped/failed) */
  aiEnrichment: AIEnrichmentResult | null;
}

export interface EnrichmentOptions {
  /** Whether to run AI enrichment (default: true) */
  enableAI?: boolean;
  /** Whether to run entity linking (default: true) */
  enableEntityLinking?: boolean;
  /** Maximum notifications to AI-enrich per batch (default: 5) */
  aiMaxPerBatch?: number;
}

const DEFAULT_OPTIONS: Required<EnrichmentOptions> = {
  enableAI: true,
  enableEntityLinking: true,
  aiMaxPerBatch: 5,
};

// ─── PIPELINE ───────────────────────────────────────────────────────────────

/**
 * Runs the full enrichment pipeline on a single notification.
 */
export async function enrichAlert(
  alert: InboundNotification,
  options?: EnrichmentOptions,
): Promise<EnrichedAlert> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // ─── Stage 1: Source-specific parsing ─────────────────────────────────
  registerDefaultNotificationProviders();
  const resolvedProvider = resolveNotificationProvider(alert);
  const resolvedPresentation = resolvedProvider?.presentation || createFallbackPresentation(alert);

  const title = resolvedPresentation.title || alert.title;
  const body = resolvedPresentation.body ?? alert.body ?? null;
  const templateKey = resolvedPresentation.templateKey || null;
  const category = resolvedPresentation.category || alert.category;
  const presentation = {
    ...(resolvedPresentation.presentation || {}),
    ...(resolvedProvider
      ? {
          provider: resolvedProvider.provider.sourceType,
          providerSignature: resolvedProvider.signature.key,
        }
      : {}),
  };
  const actions = resolvedPresentation.actions || [];
  const isActionable = resolvedPresentation.isActionable ?? alert.isActionable;

  // ─── Stage 2: Entity linking ──────────────────────────────────────────
  let entityLinks: EntityLinkResult = {
    relatedTaskId: null,
    relatedProjectId: null,
    relatedEntityType: null,
    relatedEntityId: null,
    navigationTarget: null,
  };

  if (opts.enableEntityLinking) {
    try {
      entityLinks = await linkEntities({
        title,
        body,
        connectorType: alert.connectorType,
        connectorInstanceId: alert.connectorInstanceId,
        metadata: alert.metadata,
        entityNumber: resolvedPresentation.entityNumber,
        repository: resolvedPresentation.repository,
      });
    } catch (error) {
      connectorLogger.warn({ err: error instanceof Error ? error.message : String(error) }, '[Enrichment] Entity linking failed');
    }
  }

  // ─── Stage 3: AI enrichment (async-safe) ──────────────────────────────
  let aiEnrichment: AIEnrichmentResult | null = null;

  if (opts.enableAI) {
    const aiInput: AIEnrichmentInput = {
      notificationId: alert.id,
      title,
      body,
      connectorType: alert.connectorType,
      category,
      metadata: alert.metadata,
      presentation,
    };

    if (shouldEnrichWithAI(aiInput)) {
      try {
        aiEnrichment = await enrichWithAI(aiInput);
      } catch (error) {
        // AI is optional — log and continue
        connectorLogger.warn({ err: error instanceof Error ? error.message : String(error) }, '[Enrichment] AI enrichment failed');
      }
    }
  }

  // ─── Assemble result ──────────────────────────────────────────────────
  const enrichedMetadata: Record<string, unknown> = {
    ...alert.metadata,
    ...(resolvedPresentation.metadata || {}),
    enrichment: {
      parsedAt: new Date().toISOString(),
      hadParser: resolvedProvider !== null,
      provider: resolvedProvider?.provider.sourceType || null,
      providerSignature: resolvedProvider?.signature.key || null,
      hadEntityLinks: entityLinks.relatedTaskId !== null || entityLinks.relatedProjectId !== null,
      hadAI: aiEnrichment !== null,
    },
  };

  if (aiEnrichment) {
    enrichedMetadata.aiSummary = aiEnrichment.summary;
    enrichedMetadata.aiSuggestedAction = aiEnrichment.suggestedAction;
    enrichedMetadata.aiSuggestedActionReason = aiEnrichment.suggestedActionReason;
    if (aiEnrichment.contextTags?.length) {
      enrichedMetadata.aiContextTags = aiEnrichment.contextTags;
    }
  }

  return {
    original: alert,
    title,
    body,
    templateKey,
    category,
    presentation,
    actions,
    isActionable,
    providerSignature: resolvedProvider?.signature.key || null,
    metadata: enrichedMetadata,
    ...entityLinks,
    aiEnrichment,
  };
}

// ─── BATCH PROCESSING ───────────────────────────────────────────────────────

/**
 * Enriches a batch of notifications. Parsing and entity linking run for all items.
 * AI enrichment is capped at aiMaxPerBatch items (prioritizing actionable ones).
 */
export async function enrichAlertBatch(
  alerts: InboundNotification[],
  options?: EnrichmentOptions,
): Promise<EnrichedAlert[]> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const results: EnrichedAlert[] = [];

  let aiCount = 0;

  for (const alert of alerts) {
    // Determine if this alert should get AI enrichment
    const shouldAI = opts.enableAI && aiCount < opts.aiMaxPerBatch;
    const enriched = await enrichAlert(alert, {
      ...opts,
      enableAI: shouldAI,
    });

    if (enriched.aiEnrichment) {
      aiCount++;
    }

    results.push(enriched);
  }

  return results;
}
