export interface EmbeddingCacheEntry {
  id: string;
  entityType: 'task' | 'alert';
  entityId: string;
  embedding: Float32Array;
  norm: number;
  updatedAt: string;
  provider: string;
  model: string;
}

export interface EmbeddingCacheMetrics {
  entries: number;
  estimatedBytes: number;
  maxEntries: number;
  maxBytes: number;
  hits: number;
  misses: number;
  reloads: number;
  evictions: number;
  rejectedOversize: number;
}

const ENTRY_OVERHEAD_BYTES = 96;
const textEncoder = new TextEncoder();

function estimateEntryBytes(entry: EmbeddingCacheEntry): number {
  return entry.embedding.byteLength
    + textEncoder.encode(
      entry.id
      + entry.entityId
      + entry.updatedAt
      + entry.provider
      + entry.model,
    ).byteLength
    + ENTRY_OVERHEAD_BYTES;
}

export class EmbeddingCache {
  private readonly entries = new Map<string, {
    entry: EmbeddingCacheEntry;
    estimatedBytes: number;
  }>();
  private estimatedBytes = 0;
  private hits = 0;
  private misses = 0;
  private reloads = 0;
  private evictions = 0;
  private rejectedOversize = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
  ) {}

  get(
    id: string,
    updatedAt: string,
    provider: string,
    model: string,
  ): EmbeddingCacheEntry | undefined {
    const cached = this.entries.get(id);
    if (
      !cached
      || cached.entry.updatedAt !== updatedAt
      || cached.entry.provider !== provider
      || cached.entry.model !== model
    ) {
      this.misses++;
      if (cached) this.delete(id);
      return undefined;
    }

    this.hits++;
    this.entries.delete(id);
    this.entries.set(id, cached);
    return cached.entry;
  }

  set(entry: EmbeddingCacheEntry): boolean {
    this.reloads++;
    this.delete(entry.id);
    const estimatedBytes = estimateEntryBytes(entry);
    if (estimatedBytes > this.maxBytes || this.maxEntries < 1) {
      this.rejectedOversize++;
      return false;
    }

    while (
      this.entries.size >= this.maxEntries
      || this.estimatedBytes + estimatedBytes > this.maxBytes
    ) {
      const oldestId = this.entries.keys().next().value as string | undefined;
      if (!oldestId) break;
      this.delete(oldestId);
      this.evictions++;
    }

    this.entries.set(entry.id, { entry, estimatedBytes });
    this.estimatedBytes += estimatedBytes;
    return true;
  }

  delete(id: string): void {
    const cached = this.entries.get(id);
    if (!cached) return;
    this.entries.delete(id);
    this.estimatedBytes -= cached.estimatedBytes;
  }

  clear(): void {
    this.entries.clear();
    this.estimatedBytes = 0;
  }

  getMetrics(): EmbeddingCacheMetrics {
    return {
      entries: this.entries.size,
      estimatedBytes: this.estimatedBytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      hits: this.hits,
      misses: this.misses,
      reloads: this.reloads,
      evictions: this.evictions,
      rejectedOversize: this.rejectedOversize,
    };
  }
}
