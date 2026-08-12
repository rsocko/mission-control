import { z } from 'zod';
import type { TriageItem } from '@/types';

export const TRIAGE_SUMMARY_RESOURCE_URI = 'ui://mc/triage-summary';
export const MAX_TRIAGE_SUMMARY_ITEMS = 50;

const triageStatusSchema = z.enum([
  'pending',
  'snoozed',
  'actioned',
  'dismissed',
]);

function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function isSafeThumbnailUrl(value: string): boolean {
  if (
    value.startsWith('/api/assets/thumbnails/')
    || value.startsWith('/api/triage/capture/image/')
  ) {
    return true;
  }

  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  } catch {
    return false;
  }
}

function resolveHostedThumbnailUrl(
  value: string | undefined,
  thumbnailBaseUrl: string | undefined,
): string | undefined {
  if (!value || !thumbnailBaseUrl) return undefined;

  try {
    const baseUrl = new URL(thumbnailBaseUrl);
    const thumbnailUrl = new URL(value, baseUrl);
    const isHostedAsset = thumbnailUrl.pathname.startsWith('/api/assets/thumbnails/')
      || thumbnailUrl.pathname.startsWith('/api/triage/capture/image/');

    return thumbnailUrl.origin === baseUrl.origin && isHostedAsset
      ? thumbnailUrl.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

const optionalExternalUrlSchema = z.string().max(2_048).refine(isSafeExternalUrl).optional();
const optionalThumbnailUrlSchema = z.string().max(2_048).refine(isSafeThumbnailUrl).optional();

export const triageSummaryItemSchema = z.object({
  id: z.string().min(1).max(200),
  source: z.string().min(1).max(100),
  title: z.string().min(1).max(500),
  url: optionalExternalUrlSchema,
  summary: z.string().max(2_000).optional(),
  score: z.number().finite().min(0).max(100),
  capturedAt: z.string().refine(value => !Number.isNaN(Date.parse(value)), 'Invalid captured date'),
  status: triageStatusSchema,
  contentType: z.string().min(1).max(100),
  categories: z.array(z.string().min(1).max(100)).max(20),
  thumbnailUrl: optionalThumbnailUrlSchema,
}).strict();

export const triageSummaryDataSchema = z.object({
  resourceUri: z.literal(TRIAGE_SUMMARY_RESOURCE_URI),
  title: z.string().min(1).max(200),
  items: z.array(triageSummaryItemSchema).max(MAX_TRIAGE_SUMMARY_ITEMS),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  mcBaseUrl: optionalExternalUrlSchema,
}).strict();

export type TriageSummaryItem = z.infer<typeof triageSummaryItemSchema>;
export type TriageSummaryData = z.infer<typeof triageSummaryDataSchema>;

function optionalSafeUrl(value: string | undefined, predicate: (candidate: string) => boolean) {
  return value && predicate(value) ? value : undefined;
}

export function toTriageSummaryItem(
  item: TriageItem,
  options: { thumbnailBaseUrl?: string } = {},
): TriageSummaryItem {
  const score = Number.isFinite(item.aiRelevanceScore) ? item.aiRelevanceScore : 0;
  const capturedAt = Number.isNaN(Date.parse(item.capturedAt))
    ? new Date(0).toISOString()
    : item.capturedAt;
  const url = optionalSafeUrl(item.sourceUrl, isSafeExternalUrl);
  const summary = (item.aiSummary || item.description)?.slice(0, 2_000);
  const thumbnailUrl = options.thumbnailBaseUrl
    ? resolveHostedThumbnailUrl(item.thumbnailUrl, options.thumbnailBaseUrl)
    : optionalSafeUrl(item.thumbnailUrl, isSafeThumbnailUrl);

  return {
    id: item.id.slice(0, 200),
    source: item.sourcePlatform.trim().slice(0, 100) || 'web',
    title: item.title.trim().slice(0, 500) || 'Untitled triage item',
    ...(url ? { url } : {}),
    ...(summary ? { summary } : {}),
    score: Math.min(100, Math.max(0, score)),
    capturedAt,
    status: item.status,
    contentType: item.contentType.trim().slice(0, 100) || 'link',
    categories: item.aiCategories
      .filter(category => category.trim().length > 0)
      .slice(0, 20)
      .map(category => category.slice(0, 100)),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
  };
}

export function buildTriageSummaryData({
  items,
  total,
  hasMore,
  title,
  mcBaseUrl,
  thumbnailBaseUrl,
}: {
  items: TriageItem[];
  total: number;
  hasMore: boolean;
  title: string;
  mcBaseUrl?: string;
  thumbnailBaseUrl?: string;
}): TriageSummaryData {
  const boundedItems = items.slice(0, MAX_TRIAGE_SUMMARY_ITEMS);
  const safeBaseUrl = optionalSafeUrl(mcBaseUrl, isSafeExternalUrl);
  return triageSummaryDataSchema.parse({
    resourceUri: TRIAGE_SUMMARY_RESOURCE_URI,
    title: title.trim().slice(0, 200) || 'Triage summary',
    items: boundedItems.map(item => toTriageSummaryItem(item, { thumbnailBaseUrl })),
    total,
    hasMore: hasMore || items.length > boundedItems.length,
    ...(safeBaseUrl ? { mcBaseUrl: safeBaseUrl } : {}),
  });
}
