/**
 * Translates raw Kiro CLI error events into user-facing notification messages.
 *
 * Pure function — no side effects, trivially testable.
 * The renderer calls this to convert process-level errors (stderr, exit)
 * into Flashbar items the user can understand and act on.
 */
import type { CliErrorEvent } from '../types';

export type CliNotificationType = 'info' | 'warning' | 'error';

export interface CliNotification {
  message: string;
  type: CliNotificationType;
}

/**
 * Translate a raw CLI error event into a user-facing notification.
 * Returns `null` for events that should not be surfaced (e.g. noisy debug output).
 * Surfaces the actual CLI message so the user sees exactly what went wrong.
 */
export function translateCliError(event: CliErrorEvent): CliNotification | null {
  if (event.type === 'stderr') {
    const msg = event.message.trim();
    if (!msg) return null;

    // Filter out noisy debug/info/trace lines that aren't actionable
    if (/^\[?(debug|info|trace)\]?/i.test(msg)) return null;
    // Filter out very short non-error noise
    if (msg.length < 10 && !/error|fail|warn/i.test(msg)) return null;
    // Only surface lines that look like actual errors
    if (!/error|fail|exception|fatal|panic|crash|expired|unauthorized|not logged in/i.test(msg)) return null;

    return { message: msg, type: 'warning' };
  }

  if (event.type === 'exit') {
    if (event.code === 0 || event.code === null) {
      return {
        message: 'The policy engine disconnected. Reconnecting automatically…',
        type: 'info',
      };
    }

    return {
      message: `The policy engine stopped unexpectedly (exit code ${event.code}). Your work is saved — try sending another message to reconnect.`,
      type: 'error',
    };
  }

  return null;
}
