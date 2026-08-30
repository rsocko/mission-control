export interface QueryEmbedding {
  embedding: number[];
  provider: string;
  model: string;
  dimensions: number;
  fallbackOccurred: boolean;
  correlationId: string;
}

export interface QueryEmbeddingCacheMetrics {
  entries: number;
  inFlight: number;
  maxEntries: number;
  ttlMs: number;
  hits: number;
  misses: number;
  coalesced: number;
  stores: number;
  failures: number;
  evictions: number;
  expirations: number;
}

interface CacheEntry {
  value: QueryEmbedding;
  expiresAt: number;
}

export class QueryEmbeddingCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<QueryEmbedding | null>>();
  private hits = 0;
  private misses = 0;
  private coalesced = 0;
  private stores = 0;
  private failures = 0;
  private evictions = 0;
  private expirations = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  async getOrCreate(
    key: string,
    load: () => Promise<QueryEmbedding | null>,
  ): Promise<QueryEmbedding | null> {
    const now = this.clock();
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > now) {
      this.hits++;
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.value;
    }
    if (cached) {
      this.entries.delete(key);
      this.expirations++;
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      this.coalesced++;
      return pending;
    }

    this.misses++;
    const promise = load()
      .then((value) => {
        if (!value) {
          this.failures++;
          return null;
        }
        if (this.maxEntries > 0 && this.ttlMs > 0) {
          while (this.entries.size >= this.maxEntries) {
            const oldest = this.entries.keys().next().value as string | undefined;
            if (!oldest) break;
            this.entries.delete(oldest);
            this.evictions++;
          }
          this.entries.set(key, {
            value,
            expiresAt: this.clock() + this.ttlMs,
          });
          this.stores++;
        }
        return value;
      })
      .catch((error) => {
        this.failures++;
        throw error;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  clear() {
    this.entries.clear();
    this.inFlight.clear();
  }

  getMetrics(): QueryEmbeddingCacheMetrics {
    return {
      entries: this.entries.size,
      inFlight: this.inFlight.size,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
      hits: this.hits,
      misses: this.misses,
      coalesced: this.coalesced,
      stores: this.stores,
      failures: this.failures,
      evictions: this.evictions,
      expirations: this.expirations,
    };
  }
}
