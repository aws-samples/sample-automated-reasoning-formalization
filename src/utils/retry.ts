/**
 * Exponential backoff retry utility for handling ThrottlingException,
 * ACP transient errors, and other recoverable failures.
 */

/** Errors considered transient and worth retrying. */
function isThrottlingError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message ?? "";
  const name = (err as { name?: string }).name ?? "";
  return (
    name === "ThrottlingException" ||
    name === "TooManyRequestsException" ||
    msg.includes("Too many requests") ||
    msg.includes("ThrottlingException") ||
    msg.includes("Rate exceeded") ||
    msg.includes("Throttling")
  );
}
/**
 * Detect error indicators in ACP tool_result content strings.
 * Shared across all modules that inspect streamed tool results.
 */
export function isToolResultError(content: string): boolean {
  return /error|exception|failed|AccessDeniedException|ValidationException|UnauthorizedException/i.test(content);
}


/**
 * Detect ACP / JSON-RPC errors that are transient and recoverable
 * by reconnecting the ACP session.
 *
 * -32603 = Internal error (server-side hiccup)
 * "ACP process not running" / "ACP process terminated" = subprocess crashed
 * "ACP client not started" = main-process client was torn down
 *
 * Explicitly excludes user-initiated cancellations — those should propagate
 * immediately without triggering reconnection attempts.
 */
export function isAcpTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message ?? "";

  // User-initiated cancellation is NOT transient — don't retry or reconnect
  if (msg.includes("Prompt cancelled by user") || msg.includes("cancelled")) {
    return false;
  }

  return (
    msg.includes("ACP error -32603") ||
    msg.includes("ACP process not running") ||
    msg.includes("ACP process terminated") ||
    msg.includes("ACP client not started") ||
    msg.includes("Error invoking remote method")
  );
}

export interface RetryOptions {
  /** Max number of retries (default: 4) */
  maxRetries?: number;
  /** Initial delay in ms before first retry (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay cap in ms (default: 30000) */
  maxDelayMs?: number;
  /** Optional callback for retry visibility. May return a Promise for async recovery (e.g. reconnection). */
  onRetry?: (attempt: number, delayMs: number) => void | Promise<void>;
  /** Custom predicate to decide if an error is retryable. Defaults to isThrottlingError. */
  isRetryable?: (err: unknown) => boolean;
}

/**
 * Execute an async function with exponential backoff on retryable errors.
 * Non-retryable errors are thrown immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 4,
    baseDelayMs = 1000,
    maxDelayMs = 30_000,
    onRetry,
    isRetryable = isThrottlingError,
  } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === maxRetries) {
        throw err;
      }
      // Exponential backoff with jitter
      const delay = Math.min(baseDelayMs * 2 ** attempt + Math.random() * 500, maxDelayMs);
      await new Promise((r) => setTimeout(r, delay));
      await onRetry?.(attempt + 1, delay);
    }
  }
  throw lastError;
}

export { isThrottlingError };

// ── Polling ──

/** Thrown when pollUntil exceeds its maximum attempts. */
export class PollTimeoutError extends Error {
  constructor(label: string) {
    super(`Polling timed out: ${label}`);
    this.name = "PollTimeoutError";
  }
}

export interface PollOptions {
  /** Milliseconds between poll attempts (default: 3000). */
  intervalMs?: number;
  /** Maximum number of poll attempts (default: 100). */
  maxAttempts?: number;
  /** Maximum backoff delay cap when throttled (default: 30000). */
  maxBackoffMs?: number;
  /** Called on each poll attempt for progress visibility. */
  onAttempt?: (attempt: number) => void;
}

/**
 * Poll an async function until a predicate is satisfied.
 *
 * - Calls `fn()` up to `maxAttempts` times with `intervalMs` between calls.
 * - If `fn()` throws a throttling error, backs off exponentially instead of
 *   using the fixed interval (resets after a successful call).
 * - Non-throttling errors are thrown immediately.
 * - If the predicate is never satisfied, throws `PollTimeoutError`.
 *
 * @param fn        Async function to call each tick. Its return value is passed to `isDone`.
 * @param isDone    Predicate — return `true` to stop polling and return the value.
 * @param options   Polling configuration.
 * @param label     Human-readable label for timeout errors.
 */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  isDone: (result: T) => boolean,
  options: PollOptions = {},
  label = "pollUntil",
): Promise<T> {
  const {
    intervalMs = 3_000,
    maxAttempts = 100,
    maxBackoffMs = 30_000,
    onAttempt,
  } = options;

  let consecutiveThrottles = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    onAttempt?.(attempt);
    try {
      const result = await fn();
      consecutiveThrottles = 0;
      if (isDone(result)) return result;
    } catch (err) {
      if (isThrottlingError(err)) {
        consecutiveThrottles++;
        const backoff = Math.min(intervalMs * 2 ** consecutiveThrottles, maxBackoffMs);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      throw err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new PollTimeoutError(label);
}
