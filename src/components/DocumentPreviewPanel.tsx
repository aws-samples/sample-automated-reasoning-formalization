/**
 * DocumentPreviewPanel — React component for the document preview.
 *
 * Uses Cloudscape TreeView for hierarchical section navigation with
 * action menus per node. Preserves toolbar for batch import operations,
 * banners, loading states, and the floating "Generate Test" button.
 * Highlight rendering uses the extracted highlight engine via
 * useLayoutEffect on refs (DOM manipulation that can't be declarative).
 */
import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { Marked } from "marked";
import { sanitizeToFragment } from "../utils/sanitize-html";
import type { FidelityReport, PolicyDefinition, DocumentSection, SectionImportState, SectionImportStatus, SummarizedSection } from "../types";
import {
  applyGroundingHighlights, applyFocusedView, extractHighlightsFromReport,
  filterHighlights, type GroundingHighlight, type HighlightFilterState,
} from "../utils/highlight-engine";
import TreeView from "@cloudscape-design/components/tree-view";
import Icon from "@cloudscape-design/components/icon";
import Button from "@cloudscape-design/components/button";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Box from "@cloudscape-design/components/box";
import Spinner from "@cloudscape-design/components/spinner";
import Alert from "@cloudscape-design/components/alert";

const marked = new Marked({ async: false, gfm: true, breaks: true });

/** The public API exposed to workflows via the handle pattern. */
export interface DocumentPreviewHandle {
  loadDocument: (text: string) => void;
  loadSections: (sections: DocumentSection[], importStates: Record<string, SectionImportState>, maxLevel?: number) => void;
  updateSectionState: (sectionId: string, state: SectionImportState) => void;
  exitAccordionMode: () => void;
  setHighlightsFromSummary: (sections: SummarizedSection[]) => void;
  setHighlightsFromFidelityReport: (report: FidelityReport) => void;
  emphasize: (ruleId: string) => void;
  emphasizeVariable: (variableName: string) => void;
  setLoading: (loading: boolean, message?: string) => void;
  setRegenerateButtonVisible: (visible: boolean) => void;
  setStaleFidelityBanner: (visible: boolean) => void;
  showOpenPrompt: (message: string, buttonLabel: string, onOpen: () => void) => void;
  filterByRuleIds: (ruleIds: string[]) => void;
  filterByVariableNames: (variableNames: string[], definition: PolicyDefinition) => void;
  filterByTestFindings: (directRuleIds: string[], inferredRuleIds: string[], variableNames?: string[], testLabel?: string) => void;
  filterByEntity: (entityType: "rule" | "variable", entityId: string, definition?: PolicyDefinition) => void;
  clearFilter: () => void;
  getRawText: () => string;
  hasDocument: boolean;
  // Callback setters
  onEntityFilterBack?: () => void;
  onRegenerateFidelityReport?: () => void;
  onImportSection?: (section: DocumentSection) => void;
  onImportMultipleSections?: (sections: DocumentSection[]) => void;
  /** @deprecated No longer triggered from UI — tree view shows all heading levels natively. */
  onGranularityChange?: (maxLevel: number) => void;
  onGenerateTestFromSelection?: (selectedText: string) => void;
  onHighlightClick?: (entry: { ruleId?: string; variableName?: string }) => void;
}

// ── Tree node type for Cloudscape TreeView ──

interface SectionTreeNode {
  /** Section ID (matches DocumentSection.id) */
  id: string;
  /** Display title */
  title: string;
  /** The underlying DocumentSection */
  section: DocumentSection;
  /** Whether this is a content-preview leaf node */
  isContent?: boolean;
  /** Raw markdown for content nodes */
  markdown?: string;
  /** Nested child sections + optional content node */
  children: SectionTreeNode[];
}

/**
 * Build a nested tree from a flat list of DocumentSection objects.
 * Sections are nested by heading level: level-2 sections become children
 * of the preceding level-1 section, level-3 become children of level-2, etc.
 * Each section node also gets a content child node for the markdown preview.
 *
 * Preamble sections (level 0, text before the first heading) are not shown
 * as standalone tree nodes. Their content is prepended to the first real
 * section's content node instead.
 */
function buildSectionTree(sections: DocumentSection[]): SectionTreeNode[] {
  const roots: SectionTreeNode[] = [];
  const stack: SectionTreeNode[] = [];
  let pendingPreamble: DocumentSection | null = null;

  for (const section of sections) {
    if (section.level <= 0) {
      // Stash preamble — it will be folded into the next real section
      pendingPreamble = section;
      continue;
    }

    const node: SectionTreeNode = {
      id: section.id,
      title: section.title,
      section,
      children: [],
    };

    // Build the content for this node, prepending any stashed preamble
    const contentMarkdown = pendingPreamble
      ? pendingPreamble.content + "\n\n" + section.content
      : section.content;
    pendingPreamble = null;

    // Add a content child node for the markdown body
    node.children.push({
      id: `${section.id}__content`,
      title: "Preview",
      section,
      isContent: true,
      markdown: contentMarkdown,
      children: [],
    });

    // Pop stack until we find a parent with a lower level
    while (stack.length > 0 && stack[stack.length - 1].section.level >= section.level) {
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(node);
    } else {
      // Append after the content node so the parent's own content renders first
      const parent = stack[stack.length - 1];
      parent.children.push(node);
    }
    stack.push(node);
  }

  return roots;
}

interface DocumentPreviewPanelProps {
  onHandle: (handle: DocumentPreviewHandle) => void;
}

export function DocumentPreviewPanel({ onHandle }: DocumentPreviewPanelProps) {
  // ── Core state ──
  const [rawText, setRawText] = useState("");
  const [isAccordionMode, setIsAccordionMode] = useState(false);
  const [sections, setSections] = useState<DocumentSection[]>([]);
  const [importStates, setImportStates] = useState<Record<string, SectionImportState>>({});
  const [expandedItems, setExpandedItems] = useState<string[]>([]);

  // ── Highlight state ──
  const [groundingHighlights, setGroundingHighlights] = useState<GroundingHighlight[]>([]);
  const [filterState, setFilterState] = useState<HighlightFilterState>({ filteredRuleIds: null, filteredWeakRuleIds: null, filteredVariableNames: null });
  const [filterLabel, setFilterLabel] = useState<string | null>(null);

  // ── UI state ──
  const [loading, setLoadingState] = useState<{ active: boolean; message: string }>({ active: false, message: "" });
  const [showRegenerate, setShowRegenerate] = useState(false);
  const [staleBanner, setStaleBanner] = useState(false);
  const [openPrompt, setOpenPrompt] = useState<{ message: string; buttonLabel: string; onOpen: () => void } | null>(null);

  // ── Callback refs ──
  const callbacksRef = useRef<{
    onEntityFilterBack?: () => void;
    onRegenerateFidelityReport?: () => void;
    onImportSection?: (section: DocumentSection) => void;
    onImportMultipleSections?: (sections: DocumentSection[]) => void;
    onGranularityChange?: (maxLevel: number) => void;
    onGenerateTestFromSelection?: (selectedText: string) => void;
    onHighlightClick?: (entry: { ruleId?: string; variableName?: string }) => void;
  }>({});

  const containerRef = useRef<HTMLDivElement>(null);

  // Ref for rawText so the handle (created once) always reads the latest value
  const rawTextRef = useRef(rawText);
  rawTextRef.current = rawText;

  // ── Memoized tree ──
  const treeItems = useMemo(() => buildSectionTree(sections), [sections]);

  // ── Effective import states: cascade "completed" from parent to children ──
  const effectiveImportStates = useMemo(() => {
    const effective: Record<string, SectionImportState> = { ...importStates };

    function propagate(nodes: SectionTreeNode[], ancestorCompleted: boolean): void {
      for (const node of nodes) {
        // Content nodes share their parent section's ID — already covered
        if (node.isContent) continue;

        const nodeCompleted = effective[node.section.id]?.status === "completed";
        if (ancestorCompleted && !nodeCompleted) {
          effective[node.section.id] = { sectionId: node.section.id, status: "completed" };
        }

        propagate(node.children, ancestorCompleted || nodeCompleted);
      }
    }

    propagate(treeItems, false);
    return effective;
  }, [importStates, treeItems]);

  // ── Derived: active filter flag (used in multiple places) ──
  const hasActiveFilter = useMemo(
    () => filterState.filteredRuleIds !== null || filterState.filteredVariableNames !== null || filterLabel !== null,
    [filterState.filteredRuleIds, filterState.filteredVariableNames, filterLabel],
  );

  // ── Stable highlight click handler ──
  const handleHighlightClick = useCallback(
    (ruleId?: string, variableName?: string) => {
      callbacksRef.current.onHighlightClick?.({ ruleId, variableName });
    },
    [],
  );

  // Sections eligible for batch import (not already imported or in progress)
  const eligibleForImport = useMemo(() => {
    return sections.filter((s) => {
      const st = effectiveImportStates[s.id]?.status;
      return st !== "completed" && st !== "in_progress";
    });
  }, [sections, effectiveImportStates]);

  // ── Expose handle ──
  useEffect(() => {
    const handle: DocumentPreviewHandle = {
      loadDocument: (text) => { setRawText(text); setIsAccordionMode(false); setOpenPrompt(null); },
      loadSections: (secs, states) => {
        setSections(secs);
        setImportStates({ ...states });
        setIsAccordionMode(true);
        setRawText(secs.map((s) => s.content).join("\n"));
        setExpandedItems((prev) => prev.length === 0 && secs.length > 0 ? [secs[0].id] : prev);
        setOpenPrompt(null);
      },
      updateSectionState: (id, state) => setImportStates((prev) => ({ ...prev, [id]: state })),
      exitAccordionMode: () => { setIsAccordionMode(false); setSections([]); setImportStates({}); setExpandedItems([]); },
      setHighlightsFromSummary: () => { /* legacy — not used in tree mode */ },
      setHighlightsFromFidelityReport: (report) => { setGroundingHighlights(extractHighlightsFromReport(report)); setStaleBanner(false); },
      emphasize: (ruleId) => {
        containerRef.current?.querySelectorAll(".doc-highlight").forEach((el) => el.classList.remove("active"));
        const target = containerRef.current?.querySelector(`[data-rule-id="${ruleId}"]`);
        if (target) { target.classList.add("active"); target.scrollIntoView({ behavior: "smooth", block: "center" }); }
      },
      emphasizeVariable: (varName) => {
        containerRef.current?.querySelectorAll(".doc-highlight").forEach((el) => el.classList.remove("active"));
        containerRef.current?.querySelectorAll(`[data-variable-name="${varName}"]`).forEach((el) => {
          el.classList.add("active"); el.scrollIntoView({ behavior: "smooth", block: "center" });
        });
      },
      setLoading: (active, message = "Loading…") => setLoadingState({ active, message }),
      setRegenerateButtonVisible: setShowRegenerate,
      setStaleFidelityBanner: setStaleBanner,
      showOpenPrompt: (message, buttonLabel, onOpen) => setOpenPrompt({ message, buttonLabel, onOpen }),
      filterByRuleIds: (ids) => { setFilterState({ filteredRuleIds: new Set(ids), filteredWeakRuleIds: null, filteredVariableNames: null }); setFilterLabel(null); },
      filterByVariableNames: (names, def) => {
        const varSet = new Set(names);
        const ruleIds = def.rules.filter((r) => [...varSet].some((v) => r.expression.includes(v))).map((r) => r.ruleId);
        setFilterState({ filteredRuleIds: new Set(ruleIds), filteredWeakRuleIds: null, filteredVariableNames: null });
      },
      filterByTestFindings: (direct, inferred, vars = [], testLabel) => {
        setFilterState({
          filteredRuleIds: new Set([...direct, ...inferred]),
          filteredWeakRuleIds: new Set(inferred.filter((id) => !direct.includes(id))),
          filteredVariableNames: vars.length > 0 ? new Set(vars) : null,
        });
        setFilterLabel(testLabel ?? null);
      },
      filterByEntity: (type, id, def) => {
        if (type === "rule") {
          setFilterState({ filteredRuleIds: new Set([id]), filteredWeakRuleIds: null, filteredVariableNames: null });
          setFilterLabel(`Rule ${id}`);
        } else {
          const ruleIds = def ? def.rules.filter((r) => r.expression.includes(id)).map((r) => r.ruleId) : [];
          setFilterState({ filteredRuleIds: ruleIds.length > 0 ? new Set(ruleIds) : null, filteredWeakRuleIds: null, filteredVariableNames: new Set([id]) });
          setFilterLabel(`Variable "${id}"`);
        }
      },
      clearFilter: () => { setFilterState({ filteredRuleIds: null, filteredWeakRuleIds: null, filteredVariableNames: null }); setFilterLabel(null); },
      getRawText: () => rawTextRef.current,
      get hasDocument() { return rawTextRef.current.length > 0; },
      // Callback setters
      get onEntityFilterBack() { return callbacksRef.current.onEntityFilterBack; },
      set onEntityFilterBack(fn) { callbacksRef.current.onEntityFilterBack = fn; },
      get onRegenerateFidelityReport() { return callbacksRef.current.onRegenerateFidelityReport; },
      set onRegenerateFidelityReport(fn) { callbacksRef.current.onRegenerateFidelityReport = fn; },
      get onImportSection() { return callbacksRef.current.onImportSection; },
      set onImportSection(fn) { callbacksRef.current.onImportSection = fn; },
      get onImportMultipleSections() { return callbacksRef.current.onImportMultipleSections; },
      set onImportMultipleSections(fn) { callbacksRef.current.onImportMultipleSections = fn; },
      get onGranularityChange() { return callbacksRef.current.onGranularityChange; },
      set onGranularityChange(fn) { callbacksRef.current.onGranularityChange = fn; },
      get onGenerateTestFromSelection() { return callbacksRef.current.onGenerateTestFromSelection; },
      set onGenerateTestFromSelection(fn) { callbacksRef.current.onGenerateTestFromSelection = fn; },
      get onHighlightClick() { return callbacksRef.current.onHighlightClick; },
      set onHighlightClick(fn) { callbacksRef.current.onHighlightClick = fn; },
    };
    onHandle(handle);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Text selection → Generate Test button ──
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let selBtn: HTMLElement | null = null;
    const dismiss = () => { selBtn?.remove(); selBtn = null; };
    const onMouseUp = () => {
      requestAnimationFrame(() => {
        const sel = window.getSelection();
        const text = sel?.toString().trim();
        if (!text || text.length < 5) { dismiss(); return; }
        if (sel && sel.rangeCount > 0 && container.contains(sel.getRangeAt(0).commonAncestorContainer)) {
          dismiss();
          container.querySelectorAll(".doc-grounding-highlight.active").forEach(
            (el) => el.classList.remove("active"),
          );
          const rect = sel.getRangeAt(0).getBoundingClientRect();
          const cr = container.getBoundingClientRect();
          const btn = document.createElement("button");
          btn.className = "doc-selection-test-btn";
          const icon = document.createElement("span");
          icon.className = "doc-selection-test-icon";
          icon.textContent = "⚗";
          btn.appendChild(icon);
          btn.appendChild(document.createTextNode(" Generate Test"));
          const rawTop = rect.top - cr.top + container.scrollTop - 36;
          btn.style.top = `${Math.max(container.scrollTop + 4, rawTop)}px`;
          btn.style.left = `${rect.left - cr.left + rect.width / 2}px`;
          btn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
          btn.addEventListener("click", (e) => { e.stopPropagation(); dismiss(); callbacksRef.current.onGenerateTestFromSelection?.(text); });
          container.appendChild(btn);
          selBtn = btn;
        }
      });
    };
    const onMouseDown = (e: MouseEvent) => { if (selBtn && !selBtn.contains(e.target as Node)) dismiss(); };
    container.addEventListener("mouseup", onMouseUp);
    document.addEventListener("mousedown", onMouseDown);
    return () => { container.removeEventListener("mouseup", onMouseUp); document.removeEventListener("mousedown", onMouseDown); dismiss(); };
  }, []);

  const handleImportAll = useCallback(() => {
    if (eligibleForImport.length > 0) {
      callbacksRef.current.onImportMultipleSections?.(eligibleForImport);
    }
  }, [eligibleForImport]);

  // ── Memoized renderItem for TreeView ──
  const renderTreeItem = useCallback(
    (item: SectionTreeNode) => {
      if (item.isContent) {
        return {
          content: (
            <SectionContentNode
              section={item.section}
              importStatus={effectiveImportStates[item.section.id]?.status ?? "not_started"}
              highlights={groundingHighlights}
              filterState={filterState}
              hasActiveFilter={hasActiveFilter}
              onHighlightClick={handleHighlightClick}
            />
          ),
        };
      }

      const state = effectiveImportStates[item.section.id] ?? { sectionId: item.section.id, status: "not_started" };
      const isProcessing = state.status === "in_progress";
      const isImported = state.status === "completed";
      const isFailed = state.status === "failed" || state.status === "timed_out";

      return {
        content: item.title,
        actions: (
          <span className="doc-tree-node-actions">
            <button
              type="button"
              className="doc-tree-action-icon"
              title="Suggest test"
              aria-label={`Suggest test for ${item.title}`}
              onClick={(e) => { e.stopPropagation(); callbacksRef.current.onGenerateTestFromSelection?.(item.section.content); }}
            >
              <Icon name="status-info" variant="link" />
            </button>
            <button
              type="button"
              className="doc-tree-action-icon"
              disabled={isProcessing}
              title={isImported ? "Re-import" : isFailed ? "Retry" : isProcessing ? "Processing…" : "Import"}
              aria-label={isImported ? `Re-import ${item.title}` : isFailed ? `Retry import for ${item.title}` : isProcessing ? `Import in progress for ${item.title}` : `Import ${item.title}`}
              onClick={(e) => { e.stopPropagation(); callbacksRef.current.onImportSection?.(item.section); }}
            >
              {isProcessing && <Spinner size="normal" />}
              {isImported && <Icon name="status-positive" variant="success" />}
              {isFailed && <Icon name="status-negative" variant="error" />}
              {!isProcessing && !isImported && !isFailed && <Icon name="status-pending" variant="subtle" />}
            </button>
          </span>
        ),
      };
    },
    [effectiveImportStates, groundingHighlights, filterState, hasActiveFilter, handleHighlightClick],
  );

  // ── Loading ──
  if (loading.active) {
    return (
      <Box textAlign="center" padding="l">
        <SpaceBetween size="s" alignItems="center">
          <Spinner />
          <Box color="text-body-secondary">{loading.message}</Box>
        </SpaceBetween>
      </Box>
    );
  }

  // ── Open prompt (no document loaded) ──
  if (openPrompt) {
    return (
      <Box textAlign="center" padding="l">
        <SpaceBetween size="m" alignItems="center">
          <Box>{openPrompt.message}</Box>
          <Button variant="primary" onClick={openPrompt.onOpen}>{openPrompt.buttonLabel}</Button>
        </SpaceBetween>
      </Box>
    );
  }

  return (
    <div ref={containerRef} style={{ height: "100%", overflow: "auto", position: "relative" }}>
      {/* Filter banner */}
      {filterLabel && (
        <Alert type="info" dismissible onDismiss={() => { setFilterState({ filteredRuleIds: null, filteredWeakRuleIds: null, filteredVariableNames: null }); setFilterLabel(null); callbacksRef.current.onEntityFilterBack?.(); }}>
          Showing highlights for: {filterLabel}
        </Alert>
      )}

      {/* Stale banner */}
      {staleBanner && (
        <Alert type="warning" action={<Button onClick={() => callbacksRef.current.onRegenerateFidelityReport?.()}>Refresh highlights</Button>}>
          Document highlights may not reflect your latest changes.
        </Alert>
      )}

      {/* Regenerate button */}
      {showRegenerate && (
        <div className="doc-regenerate-bar">
          <Button variant="normal" onClick={() => callbacksRef.current.onRegenerateFidelityReport?.()}>↻ Refresh document highlights</Button>
        </div>
      )}

      {/* Tree view mode */}
      {isAccordionMode && (
        <>
          {/* Toolbar — batch import */}
          {eligibleForImport.length > 0 && (
            <div className="doc-tree-toolbar">
              <Button variant="primary" onClick={handleImportAll}>
                Import all remaining ({eligibleForImport.length})
              </Button>
            </div>
          )}

          {/* Section tree */}
          <div className="doc-tree-container">
            <TreeView
              items={treeItems}
              expandedItems={expandedItems}
              getItemId={(item) => item.id}
              getItemChildren={(item) => item.children.length > 0 ? item.children : undefined}
              onItemToggle={({ detail }) => {
                setExpandedItems((prev) =>
                  detail.expanded
                    ? [...prev, detail.item.id]
                    : prev.filter((id) => id !== detail.item.id),
                );
              }}
              renderItem={renderTreeItem}
              ariaLabel="Document sections"
            />
          </div>
        </>
      )}

      {/* Full document mode */}
      {!isAccordionMode && rawText && (
        <FullDocumentView
          rawText={rawText}
          highlights={groundingHighlights}
          filterState={filterState}
          hasActiveFilter={hasActiveFilter}
          onHighlightClick={handleHighlightClick}
        />
      )}
    </div>
  );
}

// ── Sub-components ──

/** Rendered markdown content node inside the tree. */
function SectionContentNode({
  section, importStatus, highlights, filterState, hasActiveFilter, onHighlightClick,
}: {
  section: DocumentSection;
  importStatus: SectionImportStatus;
  highlights: GroundingHighlight[];
  filterState: HighlightFilterState;
  hasActiveFilter: boolean;
  onHighlightClick: (ruleId?: string, variableName?: string) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  // Safe: marked is configured with async: false, so parse() returns string synchronously
  const parsedHtml = useMemo(() => marked.parse(section.content) as string, [section.content]);

  // Set sanitized HTML and apply highlights in a single layout effect to guarantee ordering
  useLayoutEffect(() => {
    if (!bodyRef.current) return;
    bodyRef.current.replaceChildren(sanitizeToFragment(parsedHtml));
    if (importStatus !== "completed") return;
    const filtered = filterHighlights(highlights, filterState);
    if (filtered.length > 0) {
      applyGroundingHighlights(bodyRef.current, filtered, filterState, onHighlightClick);
      if (hasActiveFilter) applyFocusedView(bodyRef.current);
    }
  }, [parsedHtml, highlights, filterState, hasActiveFilter, importStatus, onHighlightClick]);

  return (
    <div className="doc-section-body" data-section-id={section.id}>
      <div ref={bodyRef} />
    </div>
  );
}

/** Full document view (non-accordion) with highlight rendering. */
function FullDocumentView({
  rawText, highlights, filterState, hasActiveFilter, onHighlightClick,
}: {
  rawText: string;
  highlights: GroundingHighlight[];
  filterState: HighlightFilterState;
  hasActiveFilter: boolean;
  onHighlightClick: (ruleId?: string, variableName?: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => marked.parse(rawText) as string, [rawText]);

  useLayoutEffect(() => {
    if (!ref.current) return;
    ref.current.replaceChildren(sanitizeToFragment(html));
    const filtered = filterHighlights(highlights, filterState);
    if (filtered.length > 0) {
      applyGroundingHighlights(ref.current, filtered, filterState, onHighlightClick);
      if (hasActiveFilter) applyFocusedView(ref.current);
    }
  }, [html, highlights, filterState, hasActiveFilter, onHighlightClick]);

  return <div ref={ref} className="doc-preview-content" />;
}
