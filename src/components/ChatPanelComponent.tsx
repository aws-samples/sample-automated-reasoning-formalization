/**
 * ChatPanelComponent — React chat panel with streaming support.
 *
 * Uses ChatContextRouter for per-context chat state isolation.
 * Cards render as React components directly (no createRoot bridge).
 * Entity linking uses useLayoutEffect on rendered markdown.
 */
import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { Marked } from "marked";
import { sanitizeToFragment } from "../utils/sanitize-html";
import type { ChatMessage, ChatCard } from "../types";
import type { ChatSegment } from "../hooks/useStreamProcessor";
import { ChatContextRouter, type ChatContextSnapshot } from "../services/chat-context-router";
import { CardRenderer } from "./cards/CardRenderer";
import Button from "@cloudscape-design/components/button";
import Box from "@cloudscape-design/components/box";
import SpaceBetween from "@cloudscape-design/components/space-between";

const marked = new Marked({ breaks: true, gfm: true });

export interface ChatPanelHandle {
  appendMessage: (msg: ChatMessage) => void;
  appendStatus: (text: string) => HTMLElement;
  updateStatus: (statusEl: HTMLElement, text: string, isError?: boolean) => void;
  startStreaming: () => HTMLElement;
  pushStreamChunk: (text: string) => void;
  endStreaming: () => void;
  abortStreaming: (anchor: HTMLElement) => void;
  noteToolCallStarted: () => void;
  /** Signal tool activity with a friendly label for the UI indicator. */
  noteToolActivity: (label: string) => void;
  setContext: (label: string, isTest?: boolean) => void;
  clearMessages: () => void;
  saveMessages: () => string;
  restoreMessages: (html: string) => void;
  restoreMessagesWithCardActions: (html: string) => void;
  restoreFilteredWithCardActions: (html: string) => string;
  restoreMessagesStrippingStaleCards: (html: string) => string;
  prefillInput: (text: string) => void;
  updateKnownEntities: (ruleIds: string[], variableNames: string[]) => void;
  linkifyEntities: (container: HTMLElement) => void;
  showEmptyImportState: () => void;
  dismissBatch: (batchId: string, chosenSegmentId: string) => void;
  /** Return the current stream generation counter (for stale-callback detection). */
  streamGeneration: () => number;
  /** Get the ChatContextRouter for creating bound UIs. */
  getRouter: () => ChatContextRouter;
  onSendMessage?: (message: string) => void;
  onCardAction?: (cardType: string, action: string, data: unknown) => void;
  onBackToPolicy?: () => void;
  onEntityClick?: (entityType: "rule" | "variable", entityId: string) => void;
}

interface ChatPanelComponentProps {
  onHandle: (handle: ChatPanelHandle) => void;
  /** Collapsed panels — when set, expand buttons appear in the chat header. */
  docCollapsed?: boolean;
  testCollapsed?: boolean;
  onExpandDoc?: () => void;
  onExpandTest?: () => void;
}

export function ChatPanelComponent({ onHandle, docCollapsed, testCollapsed, onExpandDoc, onExpandTest }: ChatPanelComponentProps) {
  const [contextLabel, setContextLabel] = useState("Policy Chat");
  const [isTestContext, setIsTestContext] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [knownRuleIds, setKnownRuleIds] = useState<Set<string>>(new Set());
  const [knownVarNames, setKnownVarNames] = useState<Set<string>>(new Set());
  const [emptyImport, setEmptyImport] = useState(false);

  // Per-context chat state — replaces the single useStreamProcessor
  const [segments, setSegments] = useState<ChatSegment[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [trailingText, setTrailingText] = useState("");
  const [hasPartialBlock, setHasPartialBlock] = useState(false);

  const routerRef = useRef<ChatContextRouter | null>(null);
  if (!routerRef.current) {
    routerRef.current = new ChatContextRouter((snapshot: ChatContextSnapshot) => {
      setSegments(snapshot.segments);
      setStreaming(snapshot.streaming);
      setTrailingText(snapshot.trailingText);
      setHasPartialBlock(snapshot.hasPartialBlock);
    });
  }
  const router = routerRef.current;

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const callbacksRef = useRef<{
    onSendMessage?: (message: string) => void;
    onCardAction?: (cardType: string, action: string, data: unknown) => void;
    onBackToPolicy?: () => void;
    onEntityClick?: (entityType: "rule" | "variable", entityId: string) => void;
  }>({});

  // Auto-scroll on new segments
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [segments, trailingText]);

  // Expose handle — uses the router's active context for all operations
  useEffect(() => {
    // Create a policy-bound UI as the default for handle methods
    const policyUI = router.createBoundUI("policy");

    const handle: ChatPanelHandle = {
      appendMessage: (msg) => {
        setEmptyImport(false);
        const key = router.getActiveKey();
        router.appendMessage(key, msg.role, msg.content, msg.cards ?? (msg.card ? [msg.card] : undefined));
      },
      appendStatus: (text) => {
        setEmptyImport(false);
        const key = router.getActiveKey();
        const ui = router.createBoundUI(key);
        return ui.appendStatus(text);
      },
      updateStatus: (statusEl, text, isError = false) => {
        const id = statusEl.dataset?.statusId;
        if (id) router.updateStatus(router.getActiveKey(), id, text, isError);
      },
      startStreaming: () => {
        setEmptyImport(false);
        const key = router.getActiveKey();
        const ui = router.createBoundUI(key);
        return ui.startStreaming();
      },
      pushStreamChunk: (text) => {
        const key = router.getActiveKey();
        const ui = router.createBoundUI(key);
        ui.pushStreamChunk(text);
      },
      endStreaming: () => {
        const key = router.getActiveKey();
        const ui = router.createBoundUI(key);
        ui.endStreaming();
      },
      abortStreaming: () => {
        const key = router.getActiveKey();
        const ui = router.createBoundUI(key);
        ui.abortStreaming(document.createElement("div"));
      },
      noteToolCallStarted: () => {
        const key = router.getActiveKey();
        const ui = router.createBoundUI(key);
        ui.noteToolCallStarted();
      },
      noteToolActivity: (label: string) => {
        const key = router.getActiveKey();
        const ui = router.createBoundUI(key);
        ui.noteToolActivity(label);
      },
      setContext: (label, isTest = false) => { setContextLabel(label); setIsTestContext(isTest); },
      clearMessages: () => { router.clear(router.getActiveKey()); setEmptyImport(false); },
      saveMessages: () => {
        const key = router.getActiveKey();
        const ui = router.createBoundUI(key);
        return ui.saveMessages();
      },
      restoreMessages: (json) => {
        const key = router.getActiveKey();
        const ui = router.createBoundUI(key);
        ui.restoreMessages(json);
      },
      restoreMessagesWithCardActions: (json) => {
        const key = router.getActiveKey();
        const ui = router.createBoundUI(key);
        ui.restoreMessages(json);
      },
      restoreFilteredWithCardActions: (json) => {
        const key = router.getActiveKey();
        const ui = router.createBoundUI(key);
        ui.restoreMessages(json);
        return json;
      },
      restoreMessagesStrippingStaleCards: (json) => {
        const key = router.getActiveKey();
        const ui = router.createBoundUI(key);
        ui.restoreMessages(json);
        return json;
      },
      prefillInput: (text) => { setInputValue(text); inputRef.current?.focus(); },
      updateKnownEntities: (ruleIds, varNames) => { setKnownRuleIds(new Set(ruleIds)); setKnownVarNames(new Set(varNames)); },
      linkifyEntities: () => { /* handled declaratively via knownRuleIds/knownVarNames state */ },
      showEmptyImportState: () => { router.clear(router.getActiveKey()); setEmptyImport(true); },
      dismissBatch: (batchId, chosenSegmentId) => router.dismissBatch(router.getActiveKey(), batchId, chosenSegmentId),
      streamGeneration: () => 0, // No longer needed with per-context isolation
      getRouter: () => router,
      get onSendMessage() { return callbacksRef.current.onSendMessage; },
      set onSendMessage(fn) { callbacksRef.current.onSendMessage = fn; },
      get onCardAction() { return callbacksRef.current.onCardAction; },
      set onCardAction(fn) { callbacksRef.current.onCardAction = fn; },
      get onBackToPolicy() { return callbacksRef.current.onBackToPolicy; },
      set onBackToPolicy(fn) { callbacksRef.current.onBackToPolicy = fn; },
      get onEntityClick() { return callbacksRef.current.onEntityClick; },
      set onEntityClick(fn) { callbacksRef.current.onEntityClick = fn; },
    };
    onHandle(handle);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSend = useCallback(() => {
    const text = inputValue.trim();
    if (!text) return;
    setInputValue("");
    router.appendMessage(router.getActiveKey(), "user", text);
    callbacksRef.current.onSendMessage?.(text);
  }, [inputValue, router]);

  const handleCardAction = useCallback((cardType: string, action: string, data: unknown) => {
    callbacksRef.current.onCardAction?.(cardType, action, data);
  }, []);

  const placeholder = isTestContext
    ? "e.g., Why did this test fail? What rules apply here?"
    : "e.g., What rules cover eligibility? Are there conflicts?";

  return (
    <>
      {/* Header */}
      <div className={["panel-header", docCollapsed && testCollapsed ? "panel-header-traffic-light-inset" : undefined].filter(Boolean).join(" ")} style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
        {/* Expand buttons for collapsed panels */}
        {testCollapsed && (
          <div className="panel-expand-buttons" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
            {docCollapsed && onExpandDoc && (
              <button className="btn-icon panel-expand-btn" aria-label="Expand document panel" onClick={onExpandDoc}>
                <span aria-hidden="true">▶</span> <span className="panel-expand-label">Document</span>
              </button>
            )}
            {onExpandTest && (
              <button className="btn-icon panel-expand-btn" aria-label="Expand test panel" onClick={onExpandTest}>
                <span aria-hidden="true">▶</span> <span className="panel-expand-label">Tests</span>
              </button>
            )}
          </div>
        )}
        <div className="chat-context-indicator" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          {isTestContext && (
            <button className="btn-icon chat-back-btn" aria-label="Back to policy chat"
              onClick={() => callbacksRef.current.onBackToPolicy?.()}>←</button>
          )}
          <span className={`chat-context-label${isTestContext ? " context-test" : ""}`}>{contextLabel}</span>
        </div>
      </div>

      {/* Messages */}
      <div className="panel-body" role="log" aria-live="polite" style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        {emptyImport && segments.length === 0 && (
          <Box textAlign="center" padding="l" color="text-body-secondary">
            Your policy workspace is ready.<br /><br />
            Choose a section from the document on the left and import it.
            The system will read your document and create formal rules you can review and test.
          </Box>
        )}

        {segments.map((seg) => (
          <SegmentRenderer
            key={seg.id}
            segment={seg}
            knownRuleIds={knownRuleIds}
            knownVarNames={knownVarNames}
            onCardAction={handleCardAction}
            onEntityClick={(type, id) => callbacksRef.current.onEntityClick?.(type, id)}
          />
        ))}

        {/* Live trailing text during streaming */}
        {streaming && trailingText.trim() && (
          <MarkdownBubble content={trailingText} role="assistant" knownRuleIds={knownRuleIds} knownVarNames={knownVarNames}
            onEntityClick={(type, id) => callbacksRef.current.onEntityClick?.(type, id)} />
        )}

        {hasPartialBlock && (
          <div className="card-loading-indicator">
            <span className="card-loading-dots"><span /><span /><span /></span> Preparing card…
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="chat-input-area">
        <label htmlFor="chat-input-field" className="sr-only">Message</label>
        <textarea
          ref={inputRef}
          id="chat-input-field"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          placeholder={placeholder}
          rows={2}
        />
        <button className="btn btn-primary" aria-label="Send message" onClick={handleSend}>Send</button>
      </div>
    </>
  );
}

// ── Sub-components ──

function SegmentRenderer({ segment, knownRuleIds, knownVarNames, onCardAction, onEntityClick }: {
  segment: ChatSegment;
  knownRuleIds: Set<string>;
  knownVarNames: Set<string>;
  onCardAction: (cardType: string, action: string, data: unknown) => void;
  onEntityClick: (type: "rule" | "variable", id: string) => void;
}) {
  if (segment.type === "loading") {
    if (segment.toolActivity) {
      return (
        <div className="chat-msg assistant streaming markdown-body tool-activity-indicator" role="status">
          <span className="card-loading-dots"><span /><span /><span /></span>
          <span>{segment.toolActivity}</span>
        </div>
      );
    }
    return (
      <div className="chat-msg assistant streaming markdown-body" role="status">
        <span className="typing-indicator" aria-label="Agent is thinking"><span /><span /><span /></span>
      </div>
    );
  }

  if (segment.type === "card" && segment.card) {
    if (segment.dismissed) return null;
    const card = segment.card;
    return (
      <div className="card-group">
        <CardRenderer card={card} onAction={(action, data) => onCardAction(card.type, action, {
          ...(data as Record<string, unknown>),
          __batchId: segment.batchId,
          __segmentId: segment.id,
        })} />
        {segment.dismissSummary && (
          <Box color="text-body-secondary" fontSize="body-s" padding={{ top: "xs" }}>
            {segment.dismissSummary}
          </Box>
        )}
      </div>
    );
  }

  // Text segment — parse the role prefix
  const content = segment.content;
  if (content.startsWith("__user__:")) {
    return <div className="chat-msg user">{content.slice(9)}</div>;
  }
  if (content.startsWith("__status__:") || content.startsWith("__status_error__:")) {
    const isError = content.startsWith("__status_error__:");
    const text = content.replace(/^__status(?:_error)?__:/, "");
    if (!text) return null;
    return (
      <div className="chat-msg assistant status-bubble" role="status">
        <div className={`status-current-step${isError ? " status-step-error" : ""}`}>{text}</div>
      </div>
    );
  }
  if (content.startsWith("__assistant__:")) {
    return <MarkdownBubble content={content.slice(14)} role="assistant" knownRuleIds={knownRuleIds} knownVarNames={knownVarNames} onEntityClick={onEntityClick} />;
  }
  // Default: assistant markdown
  return <MarkdownBubble content={content} role="assistant" knownRuleIds={knownRuleIds} knownVarNames={knownVarNames} onEntityClick={onEntityClick} />;
}

function MarkdownBubble({ content, role, knownRuleIds, knownVarNames, onEntityClick }: {
  content: string;
  role: "user" | "assistant";
  knownRuleIds: Set<string>;
  knownVarNames: Set<string>;
  onEntityClick: (type: "rule" | "variable", id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => marked.parse(content) as string, [content]);

  // Set sanitized HTML and apply entity linking in a single layout effect
  useLayoutEffect(() => {
    if (!ref.current) return;
    ref.current.replaceChildren(sanitizeToFragment(html));
    if (knownRuleIds.size === 0 && knownVarNames.size === 0) return;
    linkifyEntitiesInDom(ref.current, knownRuleIds, knownVarNames, onEntityClick);
  }, [html, knownRuleIds, knownVarNames, onEntityClick]);

  return (
    <div ref={ref} className={`chat-msg ${role} markdown-body`} />
  );
}

/** Post-process rendered HTML to wrap known entity IDs in clickable links. */
function linkifyEntitiesInDom(
  container: HTMLElement,
  ruleIds: Set<string>,
  varNames: Set<string>,
  onClick: (type: "rule" | "variable", id: string) => void,
): void {
  // Linkify <code> elements
  container.querySelectorAll<HTMLElement>("code").forEach((code) => {
    if (code.closest("pre")) return;
    const text = code.textContent?.trim() ?? "";
    if (ruleIds.has(text)) code.replaceWith(createEntityLink("rule", text, onClick));
    else if (varNames.has(text)) code.replaceWith(createEntityLink("variable", text, onClick));
  });

  // Linkify rule IDs in plain text
  if (ruleIds.size === 0) return;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest("pre, code, a, .entity-link") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

  for (const textNode of textNodes) {
    const content = textNode.textContent ?? "";
    let hasAny = false;
    for (const id of ruleIds) { if (content.includes(id)) { hasAny = true; break; } }
    if (!hasAny) continue;

    const frag = document.createDocumentFragment();
    let remaining = content;
    let didReplace = false;
    while (remaining.length > 0) {
      let bestIdx = -1, bestId = "";
      for (const id of ruleIds) {
        const idx = remaining.indexOf(id);
        if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) { bestIdx = idx; bestId = id; }
      }
      if (bestIdx === -1) { frag.appendChild(document.createTextNode(remaining)); break; }
      if (bestIdx > 0) frag.appendChild(document.createTextNode(remaining.slice(0, bestIdx)));
      frag.appendChild(createEntityLink("rule", bestId, onClick));
      didReplace = true;
      remaining = remaining.slice(bestIdx + bestId.length);
    }
    if (didReplace) textNode.replaceWith(frag);
  }
}

function createEntityLink(type: "rule" | "variable", id: string, onClick: (type: "rule" | "variable", id: string) => void): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "entity-link";
  link.href = "#";
  link.setAttribute("data-entity-type", type);
  link.textContent = id;
  link.title = type === "rule" ? `View rule ${id} in document` : `View variable "${id}" in document`;
  link.addEventListener("click", (e) => { e.preventDefault(); onClick(type, id); });
  return link;
}
