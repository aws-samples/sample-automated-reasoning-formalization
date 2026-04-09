/**
 * useStreamProcessor — React hook for incremental chat stream processing.
 *
 * Accumulates text chunks, detects card boundaries (```json or <card>),
 * and produces a list of ChatSegment objects. The component renders from
 * this segment list. Each segment gets a stable key so React doesn't
 * re-render already-committed segments.
 */
import { useCallback, useRef, useState } from "react";
import type { ChatCard } from "../types";
import { processRaw } from "../utils/stream-parser";

export interface ChatSegment {
  id: string;
  type: "text" | "card" | "loading";
  content: string;
  card?: ChatCard;
  batchId?: string;
  dismissed?: boolean;
  dismissSummary?: string;
  /** Friendly label shown on loading segments during tool execution. */
  toolActivity?: string;
}

interface StreamState {
  raw: string;
  processedUpTo: number;
  currentTextContent: string;
  batchId: string;
  paused: boolean;
}

let segmentCounter = 0;
function nextId(): string { return `seg-${++segmentCounter}`; }

export function useStreamProcessor() {
  const [segments, setSegments] = useState<ChatSegment[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [trailingText, setTrailingText] = useState("");
  const [hasPartialBlock, setHasPartialBlock] = useState(false);
  const stateRef = useRef<StreamState>({ raw: "", processedUpTo: 0, currentTextContent: "", batchId: "", paused: false });
  /** Monotonic generation counter — incremented on every startStreaming / clearMessages. */
  const generationRef = useRef(0);

  /** Return the current generation so callers can snapshot it before async work. */
  const streamGeneration = useCallback(() => generationRef.current, []);

  const startStreaming = useCallback(() => {
    const batchId = crypto.randomUUID();
    stateRef.current = { raw: "", processedUpTo: 0, currentTextContent: "", batchId, paused: false };
    setStreaming(true);
    setTrailingText("");
    setHasPartialBlock(false);
    // Don't clear segments — they accumulate across the conversation
    // Add a typing indicator segment
    setSegments((prev) => [...prev, { id: nextId(), type: "loading", content: "", batchId }]);
  }, []);

  const pushChunk = useCallback((chunk: string) => {
    const s = stateRef.current;
    if (s.paused) { s.paused = false; s.raw += "\n\n"; }
    s.raw += chunk;

    const { segments: newSegs, newProcessedUpTo, newTextContent, hasPartial } = processRaw(
      s.raw, s.processedUpTo, s.currentTextContent, s.batchId, nextId,
    );
    s.processedUpTo = newProcessedUpTo;
    s.currentTextContent = newTextContent;

    // Compute trailing text for the live bubble
    const trailing = s.raw.slice(s.processedUpTo);
    let safeTrailing: string;
    if (hasPartial) {
      const jsonIdx = trailing.lastIndexOf("```json");
      const xmlIdx = trailing.lastIndexOf("<card");
      safeTrailing = trailing.slice(0, Math.max(jsonIdx, xmlIdx));
    } else {
      safeTrailing = trailing;
    }

    setHasPartialBlock(hasPartial);
    setTrailingText(newTextContent + safeTrailing);

    if (newSegs.length > 0) {
      setSegments((prev) => {
        // Remove the loading indicator if present, then add new segments
        const withoutLoading = prev.filter((seg) => !(seg.type === "loading" && seg.batchId === s.batchId));
        return [...withoutLoading, ...newSegs, { id: nextId(), type: "loading", content: "", batchId: s.batchId }];
      });
    }
  }, []);

  const endStreaming = useCallback(() => {
    const s = stateRef.current;
    const trailing = s.raw.slice(s.processedUpTo);
    const finalText = s.currentTextContent + trailing;

    setSegments((prev) => {
      const withoutLoading = prev.filter((seg) => !(seg.type === "loading" && seg.batchId === s.batchId));
      if (finalText.trim()) {
        return [...withoutLoading, { id: nextId(), type: "text", content: finalText }];
      }
      return withoutLoading;
    });
    setStreaming(false);
    setTrailingText("");
    setHasPartialBlock(false);
  }, []);

  const abortStreaming = useCallback(() => {
    const batchId = stateRef.current.batchId;
    setSegments((prev) => prev.filter((seg) => seg.batchId !== batchId));
    setStreaming(false);
    setTrailingText("");
    setHasPartialBlock(false);
  }, []);

  const noteToolCallStarted = useCallback(() => {
    stateRef.current.paused = true;
  }, []);

  const noteToolActivity = useCallback((label: string) => {
    stateRef.current.paused = true;
    // Update the loading segment's toolActivity field
    const batchId = stateRef.current.batchId;
    setSegments((prev) => prev.map((seg) =>
      seg.type === "loading" && seg.batchId === batchId ? { ...seg, toolActivity: label } : seg
    ));
  }, []);

  const appendMessage = useCallback((role: "user" | "assistant", content: string, cards?: ChatCard[]) => {
    const segs: ChatSegment[] = [{ id: nextId(), type: "text", content: `__${role}__:${content}` }];
    if (cards) {
      for (const card of cards) {
        segs.push({ id: nextId(), type: "card", content: "", card });
      }
    }
    setSegments((prev) => [...prev, ...segs]);
  }, []);

  const appendStatus = useCallback((text: string): string => {
    const id = nextId();
    setSegments((prev) => [...prev, { id, type: "text", content: `__status__:${text}` }]);
    return id;
  }, []);

  const updateStatus = useCallback((statusId: string, text: string, isError = false) => {
    setSegments((prev) => prev.map((seg) =>
      seg.id === statusId ? { ...seg, content: `__status${isError ? "_error" : ""}__:${text}` } : seg
    ));
  }, []);

  const clearMessages = useCallback(() => {
    generationRef.current++;
    setSegments([]);
    setTrailingText("");
    setHasPartialBlock(false);
  }, []);

  const dismissBatch = useCallback((batchId: string, chosenSegmentId: string) => {
    setSegments((prev) => {
      const siblings = prev.filter(
        (seg) => seg.batchId === batchId && seg.type === "card" && seg.id !== chosenSegmentId,
      );
      if (siblings.length === 0) return prev;

      const dismissedLabels = siblings.map((seg) => {
        const card = seg.card;
        if (!card) return "option";
        switch (card.type) {
          case "follow-up-prompt": return card.label;
          case "next-steps": return card.summary;
          case "proposal": return card.title;
          case "variable-proposal": return card.suggestedLabel;
          default: return "option";
        }
      });
      const summary = `${dismissedLabels.length} other option${dismissedLabels.length > 1 ? "s" : ""} dismissed: ${dismissedLabels.join(", ")}`;

      return prev.map((seg) => {
        if (seg.batchId !== batchId || seg.type !== "card") return seg;
        if (seg.id === chosenSegmentId) return { ...seg, dismissSummary: summary };
        return { ...seg, dismissed: true };
      });
    });
  }, []);

  return {
    segments, streaming, trailingText, hasPartialBlock,
    startStreaming, pushChunk, endStreaming, abortStreaming, noteToolCallStarted, noteToolActivity,
    appendMessage, appendStatus, updateStatus, clearMessages, setSegments, dismissBatch,
    streamGeneration,
  };
}
