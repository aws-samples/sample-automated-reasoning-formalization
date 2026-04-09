/**
 * Unit tests for retry utilities.
 */
import { describe, it, expect, vi } from "vitest";
import { withRetry, isThrottlingError, isAcpTransientError, isToolResultError } from "./retry";

// ── isThrottlingError ──

describe("isThrottlingError", () => {
  it("returns false for non-Error values", () => {
    expect(isThrottlingError("string")).toBe(false);
    expect(isThrottlingError(null)).toBe(false);
    expect(isThrottlingError(42)).toBe(false);
  });

  it("detects ThrottlingException by name", () => {
    const err = new Error("something");
    err.name = "ThrottlingException";
    expect(isThrottlingError(err)).toBe(true);
  });

  it("detects TooManyRequestsException by name", () => {
    const err = new Error("something");
    err.name = "TooManyRequestsException";
    expect(isThrottlingError(err)).toBe(true);
  });

  it("detects throttling by message variants", () => {
    expect(isThrottlingError(new Error("Too many requests"))).toBe(true);
    expect(isThrottlingError(new Error("ThrottlingException: slow down"))).toBe(true);
    expect(isThrottlingError(new Error("Rate exceeded"))).toBe(true);
    expect(isThrottlingError(new Error("Throttling detected"))).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isThrottlingError(new Error("Not found"))).toBe(false);
    expect(isThrottlingError(new Error("Access denied"))).toBe(false);
  });
});

// ── isToolResultError ──

describe("isToolResultError", () => {
  it("detects error keywords case-insensitively", () => {
    expect(isToolResultError("Error occurred")).toBe(true);
    expect(isToolResultError("EXCEPTION thrown")).toBe(true);
    expect(isToolResultError("operation failed")).toBe(true);
    expect(isToolResultError("AccessDeniedException")).toBe(true);
    expect(isToolResultError("ValidationException")).toBe(true);
    expect(isToolResultError("UnauthorizedException")).toBe(true);
  });

  it("returns false for clean content", () => {
    expect(isToolResultError("Success: policy updated")).toBe(false);
    expect(isToolResultError("All tests passed")).toBe(false);
    expect(isToolResultError("")).toBe(false);
  });
});

// ── isAcpTransientError ──

describe("isAcpTransientError", () => {
  it("returns false for non-Error values", () => {
    expect(isAcpTransientError("string")).toBe(false);
    expect(isAcpTransientError(null)).toBe(false);
  });

  it("detects ACP error -32603", () => {
    expect(isAcpTransientError(new Error("ACP error -32603: internal"))).toBe(true);
  });

  it("detects ACP process not running", () => {
    expect(isAcpTransientError(new Error("ACP process not running"))).toBe(true);
  });

  it("detects ACP process terminated", () => {
    expect(isAcpTransientError(new Error("ACP process terminated"))).toBe(true);
  });

  it("detects ACP client not started", () => {
    expect(isAcpTransientError(new Error("ACP client not started"))).toBe(true);
  });

  it("detects Error invoking remote method", () => {
    expect(isAcpTransientError(new Error("Error invoking remote method 'acp:send'"))).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isAcpTransientError(new Error("Network timeout"))).toBe(false);
    expect(isAcpTransientError(new Error("Invalid argument"))).toBe(false);
  });
});

// ── withRetry ──

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("retries and succeeds after transient failures", async () => {
    const throttle = new Error("ThrottlingException");
    throttle.name = "ThrottlingException";
    const fn = vi.fn()
      .mockRejectedValueOnce(throttle)
      .mockRejectedValueOnce(throttle)
      .mockResolvedValue("recovered");

    const result = await withRetry(fn, { baseDelayMs: 1, maxDelayMs: 10 });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws immediately for non-retryable errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Not found"));
    await expect(withRetry(fn, { baseDelayMs: 1 })).rejects.toThrow("Not found");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("exhausts retries and throws the last error", async () => {
    const throttle = new Error("ThrottlingException");
    throttle.name = "ThrottlingException";
    const fn = vi.fn().mockRejectedValue(throttle);

    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 }),
    ).rejects.toThrow("ThrottlingException");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("calls onRetry callback with attempt and delay", async () => {
    const throttle = new Error("ThrottlingException");
    throttle.name = "ThrottlingException";
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(throttle)
      .mockResolvedValue("ok");

    await withRetry(fn, { baseDelayMs: 1, maxDelayMs: 10, onRetry });
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Number));
  });

  it("uses custom isRetryable predicate", async () => {
    const customErr = new Error("custom transient");
    const fn = vi.fn()
      .mockRejectedValueOnce(customErr)
      .mockResolvedValue("ok");

    const result = await withRetry(fn, {
      baseDelayMs: 1,
      isRetryable: (err) => (err as Error).message.includes("custom transient"),
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("respects maxDelayMs cap", async () => {
    const throttle = new Error("ThrottlingException");
    throttle.name = "ThrottlingException";
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(throttle)
      .mockRejectedValueOnce(throttle)
      .mockRejectedValueOnce(throttle)
      .mockResolvedValue("ok");

    await withRetry(fn, { baseDelayMs: 100, maxDelayMs: 150, onRetry });
    // All delays should be capped at maxDelayMs + jitter (max 500)
    for (const call of onRetry.mock.calls) {
      expect(call[1]).toBeLessThanOrEqual(650); // 150 + 500 jitter
    }
  });
});
