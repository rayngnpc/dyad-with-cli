import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpRateLimiter } from "@/ipc/utils/mcp_rate_limiter";

describe("McpRateLimiter", () => {
  let limiter: McpRateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    limiter?.dispose();
    vi.useRealTimers();
  });

  describe("isAllowed", () => {
    it("should allow requests under the limit", () => {
      limiter = new McpRateLimiter(5, 60_000);
      for (let i = 0; i < 5; i++) {
        expect(limiter.isAllowed("127.0.0.1")).toBe(true);
      }
    });

    it("should reject requests over the limit", () => {
      limiter = new McpRateLimiter(3, 60_000);
      expect(limiter.isAllowed("127.0.0.1")).toBe(true);
      expect(limiter.isAllowed("127.0.0.1")).toBe(true);
      expect(limiter.isAllowed("127.0.0.1")).toBe(true);
      expect(limiter.isAllowed("127.0.0.1")).toBe(false);
    });

    it("should track IPs independently", () => {
      limiter = new McpRateLimiter(2, 60_000);
      expect(limiter.isAllowed("10.0.0.1")).toBe(true);
      expect(limiter.isAllowed("10.0.0.1")).toBe(true);
      expect(limiter.isAllowed("10.0.0.1")).toBe(false);
      // Different IP should still be allowed
      expect(limiter.isAllowed("10.0.0.2")).toBe(true);
    });

    it("should allow requests again after the window expires", () => {
      limiter = new McpRateLimiter(2, 60_000);
      expect(limiter.isAllowed("127.0.0.1")).toBe(true);
      expect(limiter.isAllowed("127.0.0.1")).toBe(true);
      expect(limiter.isAllowed("127.0.0.1")).toBe(false);

      // Advance past the window
      vi.advanceTimersByTime(60_001);

      expect(limiter.isAllowed("127.0.0.1")).toBe(true);
    });

    it("should use a sliding window (partial expiry)", () => {
      limiter = new McpRateLimiter(3, 60_000);

      // Make 2 requests at t=0
      expect(limiter.isAllowed("127.0.0.1")).toBe(true);
      expect(limiter.isAllowed("127.0.0.1")).toBe(true);

      // Advance 30 seconds, make 1 more request (now at limit)
      vi.advanceTimersByTime(30_000);
      expect(limiter.isAllowed("127.0.0.1")).toBe(true);
      expect(limiter.isAllowed("127.0.0.1")).toBe(false);

      // Advance 31 more seconds (first 2 requests expire at t=60s)
      vi.advanceTimersByTime(31_000);

      // Should be allowed again (only 1 unexpired request from t=30s)
      expect(limiter.isAllowed("127.0.0.1")).toBe(true);
      expect(limiter.isAllowed("127.0.0.1")).toBe(true);
    });
  });

  describe("getRemainingRequests", () => {
    it("should return max when no requests made", () => {
      limiter = new McpRateLimiter(100, 60_000);
      expect(limiter.getRemainingRequests("127.0.0.1")).toBe(100);
    });

    it("should decrease as requests are made", () => {
      limiter = new McpRateLimiter(5, 60_000);
      limiter.isAllowed("127.0.0.1");
      limiter.isAllowed("127.0.0.1");
      expect(limiter.getRemainingRequests("127.0.0.1")).toBe(3);
    });

    it("should return 0 when at limit", () => {
      limiter = new McpRateLimiter(2, 60_000);
      limiter.isAllowed("127.0.0.1");
      limiter.isAllowed("127.0.0.1");
      expect(limiter.getRemainingRequests("127.0.0.1")).toBe(0);
    });

    it("should recover after window expiry", () => {
      limiter = new McpRateLimiter(2, 60_000);
      limiter.isAllowed("127.0.0.1");
      limiter.isAllowed("127.0.0.1");

      vi.advanceTimersByTime(60_001);

      expect(limiter.getRemainingRequests("127.0.0.1")).toBe(2);
    });
  });

  describe("getRetryAfterSeconds", () => {
    it("should return 0 when no requests in window", () => {
      limiter = new McpRateLimiter(5, 60_000);
      expect(limiter.getRetryAfterSeconds("127.0.0.1")).toBe(0);
    });

    it("should return time until oldest request expires", () => {
      limiter = new McpRateLimiter(2, 60_000);
      limiter.isAllowed("127.0.0.1");
      limiter.isAllowed("127.0.0.1");

      // Oldest request was at t=0, window is 60s, so retry after ~60s
      expect(limiter.getRetryAfterSeconds("127.0.0.1")).toBe(60);
    });

    it("should decrease over time", () => {
      limiter = new McpRateLimiter(2, 60_000);
      limiter.isAllowed("127.0.0.1");
      limiter.isAllowed("127.0.0.1");

      vi.advanceTimersByTime(30_000);

      expect(limiter.getRetryAfterSeconds("127.0.0.1")).toBe(30);
    });
  });

  describe("dispose", () => {
    it("should clear all tracked data", () => {
      limiter = new McpRateLimiter(5, 60_000);
      limiter.isAllowed("127.0.0.1");
      limiter.isAllowed("10.0.0.1");

      limiter.dispose();

      // After dispose, all IPs should have full quota
      expect(limiter.getRemainingRequests("127.0.0.1")).toBe(5);
      expect(limiter.getRemainingRequests("10.0.0.1")).toBe(5);
    });
  });
});
