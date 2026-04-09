/**
 * useCliErrors — subscribes to Kiro CLI process-level errors and
 * returns Cloudscape Flashbar items for display in App.tsx.
 *
 * Only shows one notification at a time. If a stderr error is already
 * showing, subsequent exit events are suppressed (the exit is a symptom).
 * Auto-dismisses info-level notifications after a timeout.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import type { FlashbarProps } from '@cloudscape-design/components/flashbar';
import { translateCliError, type CliNotification } from '../utils/cli-error-translate';

/** Auto-dismiss timeout for info-level notifications (ms). */
const INFO_DISMISS_MS = 8_000;
/** Key used for the single active notification. */
const NOTIFICATION_ID = 'cli-error';

export function useCliErrors(): {
  items: FlashbarProps.MessageDefinition[];
  dismissItem: (id: string) => void;
} {
  const [notification, setNotification] = useState<CliNotification | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Tracks whether the current notification came from stderr (higher priority than exit). */
  const isStderrRef = useRef(false);

  const dismiss = useCallback(() => {
    setNotification(null);
    isStderrRef.current = false;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const unsubscribe = window.architect.onAcpCliError((event) => {
      const translated = translateCliError(event);
      if (!translated) return;

      // If a stderr error is already showing, suppress exit events —
      // the process exit is just a symptom of the stderr error.
      if (event.type === 'exit' && isStderrRef.current) return;

      if (event.type === 'stderr') isStderrRef.current = true;

      setNotification(translated);

      // Clear any existing auto-dismiss timer
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      // Auto-dismiss info-level notifications
      if (translated.type === 'info') {
        timerRef.current = setTimeout(() => {
          setNotification(null);
          isStderrRef.current = false;
          timerRef.current = null;
        }, INFO_DISMISS_MS);
      }
    });

    return () => {
      unsubscribe();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const items: FlashbarProps.MessageDefinition[] = notification
    ? [{
        id: NOTIFICATION_ID,
        type: notification.type,
        content: notification.message,
        dismissible: true,
        onDismiss: dismiss,
      }]
    : [];

  return { items, dismissItem: dismiss };
}
