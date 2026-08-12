/**
 * Per-domain rate limiter for embed resolution.
 *
 * Prevents hammering a single domain when bulk-resolving embeds.
 * Uses a simple in-memory sliding window approach — no external dependencies.
 */

interface RateLimiterOptions {
  /** Maximum requests allowed per window (default: 5) */
  maxRequests?: number;
  /** Window duration in milliseconds (default: 10000) */
  windowMs?: number;
}

interface DomainEntry {
  timestamps: number[];
}

export class DomainRateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly domains: Map<string, DomainEntry> = new Map();

  constructor(options: RateLimiterOptions = {}) {
    this.maxRequests = options.maxRequests ?? 5;
    this.windowMs = options.windowMs ?? 10_000;
  }

  /**
   * Wait until a request slot is available for the given hostname.
   * If the domain has hit its limit within the current window,
   * delays with jitter (+0–40% random variation) before returning.
   */
  async waitForSlot(hostname: string): Promise<void> {
    const now = Date.now();
    let entry = this.domains.get(hostname);

    if (!entry) {
      entry = { timestamps: [] };
      this.domains.set(hostname, entry);
    }

    // Prune timestamps outside the current window
    entry.timestamps = entry.timestamps.filter((t) => now - t < this.windowMs);

    if (entry.timestamps.length >= this.maxRequests) {
      // Calculate how long until the oldest request exits the window
      const oldest = entry.timestamps[0];
      const baseDelay = this.windowMs - (now - oldest);
      // Add 0–40% jitter
      const jitter = baseDelay * Math.random() * 0.4;
      const delay = Math.max(0, baseDelay + jitter);

      await new Promise((resolve) => setTimeout(resolve, delay));

      // Re-prune after waiting
      const afterWait = Date.now();
      entry.timestamps = entry.timestamps.filter((t) => afterWait - t < this.windowMs);
    }

    // Record this request
    entry.timestamps.push(Date.now());
  }

  /** Reset all tracked state (useful for testing). */
  reset(): void {
    this.domains.clear();
  }
}
