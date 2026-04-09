/**
 * ToolActivityDebouncer — timing utility for tool activity indicators.
 *
 * Manages two UX timing policies:
 * 1. Show delay (250ms): Don't show the indicator for fast tool calls
 * 2. Minimum display (800ms): Once shown, keep visible long enough to read
 *
 * "Latest wins": each new noteActivity call cancels any pending timers
 * and starts fresh. The debouncer has no knowledge of segments or contexts.
 */

const SHOW_DELAY_MS = 250;
const MIN_DISPLAY_MS = 800;

export class ToolActivityDebouncer {
  private showTimerId: ReturnType<typeof setTimeout> | null = null;
  private minDisplayTimerId: ReturnType<typeof setTimeout> | null = null;
  private shownAt: number | null = null;

  /**
   * Signal that a tool call started with the given friendly label.
   * After SHOW_DELAY_MS, calls onShow if text hasn't resumed.
   */
  noteActivity(
    label: string,
    onShow: (label: string) => void,
  ): void {
    // Cancel any pending timers — "latest wins"
    this.clearTimers();

    this.showTimerId = setTimeout(() => {
      this.showTimerId = null;
      this.shownAt = Date.now();
      onShow(label);
    }, SHOW_DELAY_MS);
  }

  /**
   * Signal that text streaming resumed (tool call finished).
   * If the indicator is showing, keeps it visible for the remaining
   * minimum display window, then calls onClear.
   * If the indicator hasn't been shown yet, cancels it silently.
   */
  textResumed(onClear: () => void): void {
    // If the show timer hasn't fired yet, cancel it — tool call was fast
    if (this.showTimerId !== null) {
      this.clearTimers();
      return;
    }

    // Indicator is showing — respect minimum display time
    if (this.shownAt !== null) {
      const elapsed = Date.now() - this.shownAt;
      const remaining = MIN_DISPLAY_MS - elapsed;

      if (remaining <= 0) {
        // Already displayed long enough
        this.shownAt = null;
        onClear();
      } else {
        // Wait for the remaining window
        this.minDisplayTimerId = setTimeout(() => {
          this.minDisplayTimerId = null;
          this.shownAt = null;
          onClear();
        }, remaining);
      }
    }
  }

  /** Cancel all pending timers. Call on context clear/delete. */
  dispose(): void {
    this.clearTimers();
    this.shownAt = null;
  }

  private clearTimers(): void {
    if (this.showTimerId !== null) {
      clearTimeout(this.showTimerId);
      this.showTimerId = null;
    }
    if (this.minDisplayTimerId !== null) {
      clearTimeout(this.minDisplayTimerId);
      this.minDisplayTimerId = null;
    }
  }
}
