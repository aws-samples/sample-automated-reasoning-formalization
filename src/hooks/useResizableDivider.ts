/**
 * useResizableDivider — hook for drag-to-resize panel dividers.
 *
 * Returns a mousedown handler to attach to the divider element.
 * Calls onResize with the new width during drag.
 */
import { useCallback, useRef, useEffect } from "react";

interface UseResizableDividerOptions {
  /** Called during drag with the mouse clientX position. */
  onResize: (clientX: number) => void;
}

export function useResizableDivider({ onResize }: UseResizableDividerOptions) {
  const dragging = useRef(false);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      e.preventDefault();
      onResizeRef.current(e.clientX);
    };
    const handleMouseUp = () => { dragging.current = false; };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const onMouseDown = useCallback(() => { dragging.current = true; }, []);

  return { onMouseDown };
}
