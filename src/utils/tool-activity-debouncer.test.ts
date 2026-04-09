import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolActivityDebouncer } from './tool-activity-debouncer';

describe('ToolActivityDebouncer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('calls onShow after 250ms delay', () => {
    const debouncer = new ToolActivityDebouncer();
    const onShow = vi.fn();

    debouncer.noteActivity('Reading…', onShow);
    expect(onShow).not.toHaveBeenCalled();

    vi.advanceTimersByTime(249);
    expect(onShow).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onShow).toHaveBeenCalledWith('Reading…');
  });

  it('cancels silently if textResumed before show delay', () => {
    const debouncer = new ToolActivityDebouncer();
    const onShow = vi.fn();
    const onClear = vi.fn();

    debouncer.noteActivity('Reading…', onShow);
    vi.advanceTimersByTime(100);
    debouncer.textResumed(onClear);

    vi.advanceTimersByTime(500);
    expect(onShow).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
  });

  it('respects minimum display time when textResumed after show', () => {
    const debouncer = new ToolActivityDebouncer();
    const onShow = vi.fn();
    const onClear = vi.fn();

    debouncer.noteActivity('Reading…', onShow);
    vi.advanceTimersByTime(250); // show fires
    expect(onShow).toHaveBeenCalled();

    vi.advanceTimersByTime(300); // 300ms into display
    debouncer.textResumed(onClear);
    expect(onClear).not.toHaveBeenCalled(); // still within 800ms window

    vi.advanceTimersByTime(499);
    expect(onClear).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1); // 800ms total display
    expect(onClear).toHaveBeenCalled();
  });

  it('clears immediately if minimum display time already elapsed', () => {
    const debouncer = new ToolActivityDebouncer();
    const onShow = vi.fn();
    const onClear = vi.fn();

    debouncer.noteActivity('Reading…', onShow);
    vi.advanceTimersByTime(250); // show fires

    vi.advanceTimersByTime(800); // well past minimum
    debouncer.textResumed(onClear);
    expect(onClear).toHaveBeenCalled();
  });

  it('latest noteActivity wins — cancels previous timers', () => {
    const debouncer = new ToolActivityDebouncer();
    const onShow1 = vi.fn();
    const onShow2 = vi.fn();

    debouncer.noteActivity('First…', onShow1);
    vi.advanceTimersByTime(100);
    debouncer.noteActivity('Second…', onShow2);

    vi.advanceTimersByTime(250);
    expect(onShow1).not.toHaveBeenCalled();
    expect(onShow2).toHaveBeenCalledWith('Second…');
  });

  it('dispose cancels all pending timers', () => {
    const debouncer = new ToolActivityDebouncer();
    const onShow = vi.fn();

    debouncer.noteActivity('Reading…', onShow);
    debouncer.dispose();

    vi.advanceTimersByTime(500);
    expect(onShow).not.toHaveBeenCalled();
  });

  it('dispose cancels minimum display timer', () => {
    const debouncer = new ToolActivityDebouncer();
    const onShow = vi.fn();
    const onClear = vi.fn();

    debouncer.noteActivity('Reading…', onShow);
    vi.advanceTimersByTime(250); // show fires

    debouncer.textResumed(onClear);
    debouncer.dispose();

    vi.advanceTimersByTime(1000);
    expect(onClear).not.toHaveBeenCalled();
  });

  it('handles noteActivity after textResumed during min-display window', () => {
    const debouncer = new ToolActivityDebouncer();
    const onShow1 = vi.fn();
    const onShow2 = vi.fn();
    const onClear = vi.fn();

    // First tool call — show fires
    debouncer.noteActivity('First…', onShow1);
    vi.advanceTimersByTime(250);
    expect(onShow1).toHaveBeenCalled();

    // Text resumes — min display timer starts
    vi.advanceTimersByTime(100);
    debouncer.textResumed(onClear);

    // Second tool call arrives during min-display window
    vi.advanceTimersByTime(100);
    debouncer.noteActivity('Second…', onShow2);

    // The min-display clear should be cancelled
    vi.advanceTimersByTime(250);
    expect(onShow2).toHaveBeenCalledWith('Second…');
    expect(onClear).not.toHaveBeenCalled();
  });
});
