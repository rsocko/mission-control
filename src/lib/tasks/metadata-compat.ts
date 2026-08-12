export interface ParsedTaskMetadata {
  metadata: Record<string, unknown>;
  recoveredLegacy: boolean;
}

export function parseTaskMetadataCompat(value: unknown): ParsedTaskMetadata {
  if (value === null || value === undefined || value === '') {
    return { metadata: {}, recoveredLegacy: false };
  }

  let parsed: unknown = value;
  for (let depth = 0; depth < 2 && typeof parsed === 'string'; depth++) {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return {
        metadata: { legacyMetadata: parsed },
        recoveredLegacy: true,
      };
    }
  }

  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    return {
      metadata: { ...parsed as Record<string, unknown> },
      recoveredLegacy: false,
    };
  }

  return {
    metadata: { legacyMetadata: parsed },
    recoveredLegacy: true,
  };
}
