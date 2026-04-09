/**
 * ChatContextRouter — per-context chat state multiplexer.
 *
 * Maintains a Map<string, ChatContextState> where each entry holds its own
 * segments array and stream processing state. Streaming callbacks created via
 * createBoundUI() always write to a specific context's state, regardless of
 * which context is currently active. The component renders whichever context
 * is active via the onChange callback.
 *
 * This eliminates the "shared mutable stream" race condition where messages
 * from one chat session leak into another during context switches.
 */
import type { ChatCard } from "../types";
import type { ChatSegment } from "../hooks/useStreamProcessor";
import type { ChatSessionUI } from "./chat-session-manager";
import { processRaw } from "../utils/stream-parser";
import { extractCards, KNOWN_CARD_TYPES } from "../utils/card-parser";
import { ToolActivityDebouncer } from "../utils/tool-activity-debouncer";

let routerSegCounter = 0;
function nextId(): string { return `rseg-${++routerSegCounter}`; }

interface StreamState {
  raw: string;
  processedUpTo: number;
  currentTextContent: string;
  batchId: string;
  paused: boolean;
}

interface ChatContextState {
  segments: ChatSegment[];
  streamState: StreamState;
  streaming: boolean;
  trailingText: string;
  hasPartialBlock: boolean;
  debouncer: ToolActivityDebouncer;
}

export interface ChatContextSnapshot {
  segments: ChatSegment[];
  streaming: boolean;
  trailingText: string;
  hasPartialBlock: boolean;
}

export type OnContextChange = (snapshot: ChatContextSnapshot) => void;

function emptyStreamState(): StreamState {
  return { raw: "", processedUpTo: 0, currentTextContent: "", batchId: "", paused: false };
}

function emptyContext(): ChatContextState {
  return { segments: [], streamState: emptyStreamState(), streaming: false, trailingText: "", hasPartialBlock: false, debouncer: new ToolActivityDebouncer() };
}

export class ChatContextRouter {
  private contexts = new Map<string, ChatContextState>();
  private boundUIs = new Map<string, ChatSessionUI>();
  private activeKey = "policy";
  private onChange: OnContextChange;

  constructor(onChange: OnContextChange) {
    this.onChange = onChange;
    // Always start with a policy context
    this.contexts.set("policy", emptyContext());
  }

  /** Get or lazily create state for a context key. */
  private getOrCreate(key: string): ChatContextState {
    let ctx = this.contexts.get(key);
    if (!ctx) {
      ctx = emptyContext();
      this.contexts.set(key, ctx);
    }
    return ctx;
  }

  /** Notify the component if the given key is the active context. */
  private notifyIfActive(key: string, ctx: ChatContextState): void {
    if (key === this.activeKey) {
      this.onChange({
        segments: ctx.segments,
        streaming: ctx.streaming,
        trailingText: ctx.trailingText,
        hasPartialBlock: ctx.hasPartialBlock,
      });
    }
  }

  /** Switch the active context — triggers onChange with the new context's state. */
  setActive(key: string): void {
    this.activeKey = key;
    const ctx = this.getOrCreate(key);
    this.onChange({
      segments: ctx.segments,
      streaming: ctx.streaming,
      trailingText: ctx.trailingText,
      hasPartialBlock: ctx.hasPartialBlock,
    });
  }

  /** Return the current active context key. */
  getActiveKey(): string {
    return this.activeKey;
  }

  /** Check if a context exists. */
  has(key: string): boolean {
    return this.contexts.has(key);
  }

  /** Clear a specific context's messages. */
  clear(key: string): void {
    const ctx = this.getOrCreate(key);
    ctx.debouncer.dispose();
    ctx.segments = [];
    ctx.streamState = emptyStreamState();
    ctx.streaming = false;
    ctx.trailingText = "";
    ctx.hasPartialBlock = false;
    this.notifyIfActive(key, ctx);
  }

  /** Clear all test contexts (keys starting with "test-"). */
  clearAllTests(): void {
    for (const key of [...this.contexts.keys()]) {
      if (key.startsWith("test-")) {
        this.contexts.delete(key);
        this.boundUIs.delete(key);
      }
    }
    // If the active context was a test, switch to policy
    if (this.activeKey.startsWith("test-")) {
      this.setActive("policy");
    }
  }

  /** Delete a specific context entirely. */
  delete(key: string): void {
    const ctx = this.contexts.get(key);
    if (ctx) ctx.debouncer.dispose();
    this.contexts.delete(key);
    this.boundUIs.delete(key);
    if (this.activeKey === key) {
      this.setActive("policy");
    }
  }

  /**
   * Create a ChatSessionUI adapter bound to a specific context key.
   * All methods write to that context's state regardless of which context is active.
   * If the target context IS the active one, also triggers onChange to update the component.
   */
  createBoundUI(key: string): ChatSessionUI {
    const cached = this.boundUIs.get(key);
    if (cached) return cached;

    const self = this;

    const ui: ChatSessionUI = {
      startStreaming(): HTMLElement {
        const ctx = self.getOrCreate(key);
        const batchId = crypto.randomUUID();
        ctx.streamState = { raw: "", processedUpTo: 0, currentTextContent: "", batchId, paused: false };
        ctx.streaming = true;
        ctx.trailingText = "";
        ctx.hasPartialBlock = false;
        ctx.segments = [...ctx.segments, { id: nextId(), type: "loading", content: "", batchId }];
        self.notifyIfActive(key, ctx);
        return document.createElement("div"); // Legacy API compatibility
      },

      pushStreamChunk(text: string): void {
        const ctx = self.getOrCreate(key);
        const s = ctx.streamState;
        if (s.paused) {
          s.paused = false;
          s.raw += "\n\n";
          // Text resumed — tell debouncer to clear the activity label
          ctx.debouncer.textResumed(() => {
            if (!self.contexts.has(key)) return;
            const c = self.getOrCreate(key);
            const batchId = c.streamState.batchId;
            c.segments = c.segments.map((seg) =>
              seg.type === "loading" && seg.batchId === batchId ? { ...seg, toolActivity: undefined } : seg
            );
            self.notifyIfActive(key, c);
          });
        }
        s.raw += text;

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

        ctx.hasPartialBlock = hasPartial;
        ctx.trailingText = newTextContent + safeTrailing;

        if (newSegs.length > 0) {
          const withoutLoading = ctx.segments.filter((seg) => !(seg.type === "loading" && seg.batchId === s.batchId));
          ctx.segments = [...withoutLoading, ...newSegs, { id: nextId(), type: "loading", content: "", batchId: s.batchId }];
        }
        self.notifyIfActive(key, ctx);
      },

      endStreaming(): void {
        const ctx = self.getOrCreate(key);
        ctx.debouncer.dispose();
        const s = ctx.streamState;
        const trailing = s.raw.slice(s.processedUpTo);
        const finalText = s.currentTextContent + trailing;

        const withoutLoading = ctx.segments.filter((seg) => !(seg.type === "loading" && seg.batchId === s.batchId));
        if (finalText.trim()) {
          // Attempt card extraction on the finalized text — this catches
          // truncated JSON blocks that processRaw() couldn't match during
          // streaming (progressive JSON repair via extractCards).
          // This mirrors what sendPolicyMessage() does post-hoc.
          // The streaming UI is driven by segments (this path); the ChatMessage
          // return value from sendPolicyMessage is used only for non-UI consumers.
          const { cards, text: cleanedText, positions } = extractCards(finalText);

          const finalSegments: ChatSegment[] = [];
          if (cards.length === 0) {
            if (cleanedText.trim()) {
              finalSegments.push({ id: nextId(), type: "text", content: cleanedText });
            }
          } else {
            // Rebuild interleaved text/card segments using position data
            let textCursor = 0;
            for (let i = 0; i < cards.length; i++) {
              const textBefore = cleanedText.slice(textCursor, positions[i].start);
              if (textBefore.trim()) {
                finalSegments.push({ id: nextId(), type: "text", content: textBefore });
              }
              // Only emit cards with a known type — malformed/truncated cards
              // from interrupted streams would render as "[Unknown card type]"
              // or raw JSON code blocks. Drop them silently.
              if (KNOWN_CARD_TYPES.has(cards[i].type)) {
                finalSegments.push({ id: nextId(), type: "card", content: "", card: cards[i], batchId: s.batchId });
              }
              textCursor = positions[i].start;
            }
            const textAfter = cleanedText.slice(textCursor);
            if (textAfter.trim()) {
              finalSegments.push({ id: nextId(), type: "text", content: textAfter });
            }
          }
          ctx.segments = [...withoutLoading, ...finalSegments];
        } else {
          ctx.segments = withoutLoading;
        }
        ctx.streaming = false;
        ctx.trailingText = "";
        ctx.hasPartialBlock = false;
        self.notifyIfActive(key, ctx);
      },

      abortStreaming(anchor: HTMLElement): void {
        const ctx = self.getOrCreate(key);
        ctx.debouncer.dispose();
        const batchId = ctx.streamState.batchId;
        ctx.segments = ctx.segments.filter((seg) => seg.batchId !== batchId);
        ctx.streaming = false;
        ctx.trailingText = "";
        ctx.hasPartialBlock = false;
        self.notifyIfActive(key, ctx);
      },

      appendStatus(text: string): HTMLElement {
        const ctx = self.getOrCreate(key);
        const id = nextId();
        ctx.segments = [...ctx.segments, { id, type: "text", content: `__status__:${text}` }];
        self.notifyIfActive(key, ctx);
        const el = document.createElement("div");
        el.dataset.statusId = id;
        return el;
      },

      clearMessages(): void {
        self.clear(key);
      },

      saveMessages(): string {
        const ctx = self.getOrCreate(key);
        return JSON.stringify(ctx.segments);
      },

      restoreMessages(json: string): void {
        const ctx = self.getOrCreate(key);
        try {
          ctx.segments = JSON.parse(json);
        } catch { /* legacy HTML — ignore */ }
        self.notifyIfActive(key, ctx);
      },

      noteToolCallStarted(): void {
        const ctx = self.getOrCreate(key);
        ctx.streamState.paused = true;
      },

      noteToolActivity(label: string): void {
        const ctx = self.getOrCreate(key);
        ctx.streamState.paused = true;
        ctx.debouncer.noteActivity(label, (lbl) => {
          // Guard against deleted context during timer window
          if (!self.contexts.has(key)) return;
          const c = self.getOrCreate(key);
          const batchId = c.streamState.batchId;
          c.segments = c.segments.map((seg) =>
            seg.type === "loading" && seg.batchId === batchId ? { ...seg, toolActivity: lbl } : seg
          );
          self.notifyIfActive(key, c);
        });
      },

      streamGeneration(): number {
        // Not needed with per-context isolation, but kept for interface compat
        return 0;
      },
    };

    this.boundUIs.set(key, ui);
    return ui;
  }

  /**
   * Append a message (user or assistant) to a specific context.
   * Used by ChatPanelComponent for the appendMessage handle method.
   */
  appendMessage(key: string, role: "user" | "assistant", content: string, cards?: ChatCard[]): void {
    const ctx = this.getOrCreate(key);
    const segs: ChatSegment[] = [{ id: nextId(), type: "text", content: `__${role}__:${content}` }];
    if (cards) {
      for (const card of cards) {
        segs.push({ id: nextId(), type: "card", content: "", card });
      }
    }
    ctx.segments = [...ctx.segments, ...segs];
    this.notifyIfActive(key, ctx);
  }

  /** Update a status segment by ID in a specific context. */
  updateStatus(key: string, statusId: string, text: string, isError = false): void {
    const ctx = this.getOrCreate(key);
    ctx.segments = ctx.segments.map((seg) =>
      seg.id === statusId ? { ...seg, content: `__status${isError ? "_error" : ""}__:${text}` } : seg
    );
    this.notifyIfActive(key, ctx);
  }

  /** Dismiss a batch of card segments in a specific context. */
  dismissBatch(key: string, batchId: string, chosenSegmentId: string): void {
    const ctx = this.getOrCreate(key);
    const siblings = ctx.segments.filter(
      (seg) => seg.batchId === batchId && seg.type === "card" && seg.id !== chosenSegmentId,
    );
    if (siblings.length === 0) return;

    const dismissedLabels = siblings.map((seg) => {
      const card = seg.card;
      if (!card) return "option";
      switch (card.type) {
        case "follow-up-prompt": return (card as any).label;
        case "next-steps": return (card as any).summary;
        case "proposal": return (card as any).title;
        case "variable-proposal": return (card as any).suggestedLabel;
        default: return "option";
      }
    });
    const summary = `${dismissedLabels.length} other option${dismissedLabels.length > 1 ? "s" : ""} dismissed: ${dismissedLabels.join(", ")}`;

    ctx.segments = ctx.segments.map((seg) => {
      if (seg.batchId !== batchId || seg.type !== "card") return seg;
      if (seg.id === chosenSegmentId) return { ...seg, dismissSummary: summary };
      return { ...seg, dismissed: true };
    });
    this.notifyIfActive(key, ctx);
  }
}
