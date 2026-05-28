/**
 * Sliding-window rate limiter for the MCP server.
 *
 * Tracks request timestamps per IP address and rejects requests
 * that exceed the configured limit within the window.
 */

const DEFAULT_MAX_REQUESTS = 100;
const DEFAULT_WINDOW_MS = 60_000; // 1 minute
const CLEANUP_INTERVAL_MS = 5 * 60_000; // 5 minutes

export class McpRateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly requestLog = new Map<string, number[]>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    maxRequests: number = DEFAULT_MAX_REQUESTS,
    windowMs: number = DEFAULT_WINDOW_MS,
  ) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.startCleanup();
  }

  /**
   * Check whether a request from the given IP is allowed.
   * If allowed, the request timestamp is recorded.
   */
  isAllowed(ip: string): boolean {
    const now = Date.now();
    const timestamps = this.requestLog.get(ip) ?? [];

    // Prune expired entries
    const cutoff = now - this.windowMs;
    const valid = timestamps.filter((t) => t > cutoff);

    if (valid.length >= this.maxRequests) {
      // Update the pruned list even on rejection so we don't retain stale data
      this.requestLog.set(ip, valid);
      return false;
    }

    valid.push(now);
    this.requestLog.set(ip, valid);
    return true;
  }

  /**
   * Number of requests remaining in the current window for this IP.
   */
  getRemainingRequests(ip: string): number {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const timestamps = this.requestLog.get(ip) ?? [];
    const valid = timestamps.filter((t) => t > cutoff);
    return Math.max(0, this.maxRequests - valid.length);
  }

  /**
   * Seconds until the oldest tracked request expires for this IP.
   * Used for the Retry-After header when rate-limited.
   */
  getRetryAfterSeconds(ip: string): number {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const timestamps = this.requestLog.get(ip) ?? [];
    const valid = timestamps.filter((t) => t > cutoff);

    if (valid.length === 0) return 0;
    const oldestInWindow = Math.min(...valid);
    return Math.ceil((oldestInWindow + this.windowMs - now) / 1000);
  }

  /**
   * Remove stale IP entries whose timestamps have all expired.
   */
  private pruneStaleEntries(): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    for (const [ip, timestamps] of this.requestLog) {
      const valid = timestamps.filter((t) => t > cutoff);
      if (valid.length === 0) {
        this.requestLog.delete(ip);
      } else {
        this.requestLog.set(ip, valid);
      }
    }
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(
      () => this.pruneStaleEntries(),
      CLEANUP_INTERVAL_MS,
    );
    // Allow the process to exit without waiting for this timer
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Stop the periodic cleanup timer. Call this when shutting down the server.
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.requestLog.clear();
  }
}
