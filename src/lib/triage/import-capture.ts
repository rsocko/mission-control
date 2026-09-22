import { randomUUID } from 'crypto';
import type {
  TriageContentType,
  TriageItem,
  TriageSourcePlatform,
} from '@/types';
import logger from '@/lib/logger';
import { publishSemanticEntityUpsert } from '@/lib/semantic-index/publication-service';
import { resolveEmbed } from './embed-resolver';
import { evaluateRules } from './suggestion-engine';
import { detectBuiltInContentType } from './builtin-content-type-detection';
import { getTriagePersistenceRepositories } from './persistence';

export interface TriageImportInput {
  sourcePlatform: TriageSourcePlatform;
  sourceId: string;
  sourceUrl: string;
  canonicalUrl?: string;
  title: string;
  description?: string;
  thumbnailUrl?: string;
  capturedAt?: string;
  sourceOrder?: number;
  rawMetadata?: Record<string, unknown>;
}

export type TriageImportResult =
  | { status: 'imported'; item: TriageItem }
  | { status: 'skipped'; reason: string; item?: TriageItem };

function resolveImportEmbedAsync(itemId: string, url: string) {
  resolveEmbed(url)
    .then(async (result) => {
      if (!result.success || !result.embed) return;
      await getTriagePersistenceRepositories().capture.enrich(itemId, {
        rawMetadata: { embed: result.embed },
        ...(result.embed.thumbnail_url
          ? { thumbnailUrl: result.embed.thumbnail_url }
          : {}),
      });
    })
    .catch((err) => {
      logger.error({ err, itemId }, 'Failed to resolve imported triage embed');
    });
}

export async function ingestTriageImports(
  inputs: readonly TriageImportInput[],
): Promise<TriageImportResult[]> {
  if (inputs.length === 0) return [];

  const results: Array<TriageImportResult | undefined> = new Array(inputs.length);
  const prepared = inputs.flatMap((input, index) => {
    if (!input.sourceId?.trim()) {
      results[index] = { status: 'skipped', reason: 'Missing source ID' };
      return [];
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(input.sourceUrl);
    } catch {
      results[index] = { status: 'skipped', reason: 'Invalid source URL' };
      return [];
    }

    return [{
      index,
      input,
      parsedUrl,
      canonicalUrl: input.canonicalUrl || input.sourceUrl,
    }];
  });

  if (prepared.length === 0) {
    return results.map((result) => result!);
  }

  const items = prepared.map((candidate): TriageItem => {
    const { input, parsedUrl, canonicalUrl } = candidate;
    const title = input.title?.trim() || parsedUrl.hostname.replace('www.', '');
    const contentType = detectBuiltInContentType(
      canonicalUrl,
      title,
      input.description,
    ) as TriageContentType;
    const ai = evaluateRules({
      sourcePlatform: input.sourcePlatform,
      contentType,
      title,
      description: input.description,
      url: canonicalUrl,
      rawMetadata: input.rawMetadata,
    });
    const now = new Date().toISOString();

    return {
      id: randomUUID(),
      sourcePlatform: input.sourcePlatform,
      sourceId: input.sourceId,
      sourceUrl: input.sourceUrl,
      canonicalUrl,
      title,
      description: input.description,
      thumbnailUrl: input.thumbnailUrl,
      contentType,
      capturedAt: input.capturedAt || now,
      ingestedAt: now,
      status: 'pending',
      aiSummary: ai.summary,
      aiCategories: ai.categories,
      aiSuggestedActions: ai.actions,
      aiRelevanceScore: ai.score,
      aiUrgency: ai.urgency,
      rawMetadata: input.rawMetadata || {},
      sourceOrder: input.sourceOrder,
      actionsTaken: [],
    };
  });

  const outcomes = await getTriagePersistenceRepositories().capture.captureBatch(items);
  if (outcomes.length !== prepared.length) {
    throw new Error('Triage capture repository returned incomplete batch outcomes');
  }

  const importedItems: TriageItem[] = [];
  for (let outcomeIndex = 0; outcomeIndex < outcomes.length; outcomeIndex += 1) {
    const outcome = outcomes[outcomeIndex];
    const candidate = prepared[outcomeIndex];
    if (!outcome || !candidate) {
      throw new Error(`Missing triage import outcome at index ${outcomeIndex}`);
    }
    results[candidate.index] = outcome.status === 'imported'
      ? { status: 'imported', item: outcome.item }
      : {
          status: 'skipped',
          reason: outcome.reason === 'source-replay'
            ? 'Already ingested for this source item'
            : 'Already ingested for canonical URL',
          item: outcome.item,
        };
    if (outcome.status === 'imported') {
      importedItems.push(outcome.item);
      resolveImportEmbedAsync(outcome.item.id, candidate.canonicalUrl);
    }
  }

  await Promise.all(
    importedItems.map((item) => publishSemanticEntityUpsert('triage-item', item.id)),
  );

  return results.map((result, index) => {
    if (!result) throw new Error(`Missing triage import result at index ${index}`);
    return result;
  });
}

export async function ingestTriageImport(
  input: TriageImportInput,
): Promise<TriageImportResult> {
  const [result] = await ingestTriageImports([input]);
  if (!result) throw new Error('Triage import repository returned no outcome');
  return result;
}
