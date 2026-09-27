import type { InboxListEntry } from './contracts';

export function parseConfiguredInboxListEntries(value: unknown): InboxListEntry[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry): InboxListEntry[] => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.connectorType !== 'string') return [];

    return [{
      connectorType: record.connectorType,
      connectorInstanceId: typeof record.connectorInstanceId === 'string'
        ? record.connectorInstanceId
        : undefined,
      sourceListId: typeof record.sourceListId === 'string' ? record.sourceListId : undefined,
      sourceListName: typeof record.sourceListName === 'string' ? record.sourceListName : undefined,
    }];
  });
}

export function mergeInboxListEntries(
  configured: readonly InboxListEntry[],
  discovered: readonly InboxListEntry[],
): InboxListEntry[] {
  const entries = new Map<string, InboxListEntry>();

  for (const entry of [...configured, ...discovered]) {
    const key = [
      entry.connectorType,
      entry.connectorInstanceId ?? '',
      entry.sourceListId ?? '',
      entry.sourceListName ?? '',
    ].join('\0');
    if (!entries.has(key)) entries.set(key, entry);
  }

  return [...entries.values()];
}
