/**
 * Highlight engine — three-pass grounding highlight algorithm.
 *
 * Extracted from DocumentPreview so it can be used by the React component
 * via useLayoutEffect. Pure DOM manipulation — takes a wrapper element
 * and an array of highlights, mutates the DOM to add highlight spans.
 *
 * Pass 1: Exact substring match (literal then normalized)
 * Pass 2: Word-level LCS for unmatched statements
 * Pass 3: Sub-entity matching for enumeration statements
 */
import { normalizeForMatch, tokenize } from "./text-normalize";
import { wordLCS } from "./lcs";

export interface GroundingHighlight {
  lines: number[];
  text: string;
  ruleId?: string;
  variableName?: string;
  justification?: string;
  fuzzy?: boolean;
}

export interface HighlightFilterState {
  filteredRuleIds: Set<string> | null;
  filteredWeakRuleIds: Set<string> | null;
  filteredVariableNames: Set<string> | null;
}

export function filterHighlights(
  highlights: GroundingHighlight[],
  filter: HighlightFilterState,
): GroundingHighlight[] {
  if (!filter.filteredRuleIds && !filter.filteredVariableNames) return highlights;
  return highlights.filter((gh) => {
    if (gh.ruleId && filter.filteredRuleIds?.has(gh.ruleId)) return true;
    if (gh.variableName && filter.filteredVariableNames?.has(gh.variableName)) return true;
    return !filter.filteredRuleIds && !filter.filteredVariableNames;
  });
}

/**
 * Apply grounding highlights to a DOM element using the three-pass strategy.
 */
export function applyGroundingHighlights(
  wrapper: HTMLElement,
  highlights: GroundingHighlight[],
  filter: HighlightFilterState,
  onHighlightClick?: (ruleId?: string, variableName?: string) => void,
): void {
  const unmatchedAfterPass1: GroundingHighlight[] = [];
  const unmatchedAfterPass2: GroundingHighlight[] = [];

  for (const gh of highlights) {
    if (!tryExactMatch(wrapper, gh, filter, onHighlightClick)) {
      unmatchedAfterPass1.push(gh);
    }
  }
  for (const gh of unmatchedAfterPass1) {
    if (!tryFuzzyMatch(wrapper, gh, filter, onHighlightClick)) {
      unmatchedAfterPass2.push(gh);
    }
  }
  for (const gh of unmatchedAfterPass2) {
    trySubEntityMatch(wrapper, gh, filter, onHighlightClick);
  }
}

/**
 * Dim non-highlighted blocks and scroll to the first highlight.
 */
export function applyFocusedView(wrapper: HTMLElement): void {
  const blocks = wrapper.querySelectorAll<HTMLElement>(
    ":scope > p, :scope > ul, :scope > ol, :scope > li, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, :scope > blockquote, :scope > table, :scope > pre, :scope > hr"
  );
  for (const block of blocks) {
    const hasHighlight = block.querySelector(".doc-grounding-highlight") !== null;
    block.classList.toggle("doc-dimmed", !hasHighlight);
  }
  const first = wrapper.querySelector(".doc-grounding-highlight");
  if (first) {
    requestAnimationFrame(() => {
      first.scrollIntoView({ behavior: "smooth", block: "center" });
      first.classList.add("doc-highlight-pulse");
      first.addEventListener("animationend", () => {
        first.classList.remove("doc-highlight-pulse");
      }, { once: true });
    });
  }
}

import type { FidelityReport } from "../types";

/**
 * Extract grounding highlights from a fidelity report.
 */
export function extractHighlightsFromReport(report: FidelityReport): GroundingHighlight[] {
  const highlights: GroundingHighlight[] = [];
  const stmtMap = new Map<string, { text: string; lines: number[] }>();
  for (const doc of report.documentSources) {
    for (const stmt of doc.atomicStatements) {
      stmtMap.set(`${doc.documentId}:${stmt.id}`, { text: stmt.text, lines: stmt.location.lines });
    }
  }
  for (const [ruleId, ruleReport] of Object.entries(report.ruleReports)) {
    for (const ref of ruleReport.groundingStatements ?? []) {
      const stmt = stmtMap.get(`${ref.documentId}:${ref.statementId}`);
      if (stmt) highlights.push({ lines: stmt.lines, text: stmt.text, ruleId, justification: ruleReport.groundingJustifications?.[0] });
    }
  }
  for (const [varName, varReport] of Object.entries(report.variableReports)) {
    for (const ref of varReport.groundingStatements ?? []) {
      const stmt = stmtMap.get(`${ref.documentId}:${ref.statementId}`);
      if (stmt) highlights.push({ lines: stmt.lines, text: stmt.text, variableName: varName, justification: varReport.groundingJustifications?.[0] });
    }
  }
  return highlights;
}

// ── Internal helpers ──

function createHighlightSpan(
  gh: GroundingHighlight,
  fuzzy: boolean,
  filter: HighlightFilterState,
  container: HTMLElement,
  onHighlightClick?: (ruleId?: string, variableName?: string) => void,
): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "doc-highlight doc-grounding-highlight";
  if (fuzzy) span.classList.add("doc-grounding-fuzzy");
  if (gh.ruleId && filter.filteredWeakRuleIds?.has(gh.ruleId)) {
    span.classList.add("doc-grounding-weak");
  }
  if (gh.ruleId) span.setAttribute("data-rule-id", gh.ruleId);
  if (gh.variableName) span.setAttribute("data-variable-name", gh.variableName);
  if (gh.justification) span.title = gh.justification;

  span.addEventListener("click", () => {
    // Suppress highlight click when the user is drag-selecting text.
    // A non-empty selection that spans multiple words means the user is
    // selecting, not clicking. Single-word selections (double-click) that
    // are contained within this span are treated as intentional clicks.
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) {
      const selText = sel.toString().trim();
      const isWordSelect = !selText.includes(" ") && span.contains(sel.anchorNode);
      if (!isWordSelect) return;
      sel.removeAllRanges();
    }

    const isActive = span.classList.contains("active");
    container.querySelectorAll(".doc-grounding-highlight").forEach((el) => el.classList.remove("active"));
    if (!isActive) span.classList.add("active");
    onHighlightClick?.(gh.ruleId, gh.variableName);
  });

  return span;
}

function tryExactMatch(
  wrapper: HTMLElement,
  gh: GroundingHighlight,
  filter: HighlightFilterState,
  onHighlightClick?: (ruleId?: string, variableName?: string) => void,
): boolean {
  const searchText = gh.text.trim();
  if (!searchText) return false;

  const treeWalker = document.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT);
  let node: Text | null;
  while ((node = treeWalker.nextNode() as Text | null)) {
    const idx = node.textContent?.indexOf(searchText) ?? -1;
    if (idx === -1) continue;
    const before = node.splitText(idx);
    before.splitText(searchText.length);
    const span = createHighlightSpan(gh, false, filter, wrapper, onHighlightClick);
    span.textContent = before.textContent;
    before.parentNode!.replaceChild(span, before);
    return true;
  }

  const normalizedSearch = normalizeForMatch(searchText);
  if (normalizedSearch === searchText.toLowerCase().trim()) return false;

  const walker2 = document.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT);
  while ((node = walker2.nextNode() as Text | null)) {
    const nodeText = node.textContent ?? "";
    const normalizedNode = normalizeForMatch(nodeText);
    const idx = normalizedNode.indexOf(normalizedSearch);
    if (idx === -1) continue;
    let origStart = 0;
    let normPos = 0;
    for (let ci = 0; ci < nodeText.length && normPos < idx; ci++) {
      const ch = nodeText[ci];
      if (/\s/.test(ch)) { if (ci === 0 || !/\s/.test(nodeText[ci - 1])) normPos++; }
      else if (/[^\w\s'-]/g.test(ch)) { normPos++; }
      else { normPos++; }
      origStart = ci + 1;
    }
    const approxLen = Math.min(searchText.length + 10, nodeText.length - origStart);
    const before = node.splitText(Math.max(0, origStart - 1));
    before.splitText(Math.min(approxLen, before.textContent?.length ?? 0));
    const span = createHighlightSpan(gh, false, filter, wrapper, onHighlightClick);
    span.textContent = before.textContent;
    before.parentNode!.replaceChild(span, before);
    return true;
  }
  return false;
}

function tryFuzzyMatch(
  wrapper: HTMLElement,
  gh: GroundingHighlight,
  filter: HighlightFilterState,
  onHighlightClick?: (ruleId?: string, variableName?: string) => void,
): boolean {
  const statementTokens = tokenize(gh.text);
  if (statementTokens.length < 3) return false;
  const allBlocks = wrapper.querySelectorAll<HTMLElement>("p, li, h1, h2, h3, h4, h5, h6, blockquote");
  let bestBlock: HTMLElement | null = null;
  let bestRatio = 0;
  for (const block of allBlocks) {
    const blockTokens = tokenize(block.textContent ?? "");
    if (blockTokens.length === 0) continue;
    const { ratio } = wordLCS(statementTokens, blockTokens);
    if (ratio > bestRatio) { bestRatio = ratio; bestBlock = block; }
  }
  if (!bestBlock || bestRatio < 0.4) return false;
  const existing = bestBlock.querySelector<HTMLElement>(".doc-grounding-highlight");
  if (existing) {
    if (gh.ruleId && !existing.getAttribute("data-rule-id")) existing.setAttribute("data-rule-id", gh.ruleId);
    if (gh.variableName && !existing.getAttribute("data-variable-name")) existing.setAttribute("data-variable-name", gh.variableName);
    return true;
  }
  const span = createHighlightSpan(gh, true, filter, wrapper, onHighlightClick);
  while (bestBlock.firstChild) span.appendChild(bestBlock.firstChild);
  bestBlock.appendChild(span);
  return true;
}

function trySubEntityMatch(
  wrapper: HTMLElement,
  gh: GroundingHighlight,
  filter: HighlightFilterState,
  onHighlightClick?: (ruleId?: string, variableName?: string) => void,
): boolean {
  const text = gh.text.trim();
  if (!text) return false;
  const phrases = extractEnumeratedPhrases(text);
  if (phrases.length < 2) return false;
  const allBlocks = wrapper.querySelectorAll<HTMLElement>("li, p");
  const normalizedPhrases = phrases.map((p) => normalizeForMatch(p));
  let matchCount = 0;
  for (const block of allBlocks) {
    const blockText = normalizeForMatch(block.textContent ?? "");
    if (!blockText) continue;
    const matched = normalizedPhrases.some((phrase) => blockText.includes(phrase) || phrase.includes(blockText));
    if (!matched) continue;
    const existing = block.querySelector<HTMLElement>(".doc-grounding-highlight");
    if (existing) {
      if (gh.ruleId && !existing.getAttribute("data-rule-id")) existing.setAttribute("data-rule-id", gh.ruleId);
      if (gh.variableName && !existing.getAttribute("data-variable-name")) existing.setAttribute("data-variable-name", gh.variableName);
      matchCount++;
      continue;
    }
    const span = createHighlightSpan(gh, true, filter, wrapper, onHighlightClick);
    span.classList.add("doc-grounding-sub-entity");
    while (block.firstChild) span.appendChild(block.firstChild);
    block.appendChild(span);
    matchCount++;
  }
  return matchCount > 0;
}

function extractEnumeratedPhrases(text: string): string[] {
  let body = text;
  const colonIdx = text.indexOf(":");
  if (colonIdx !== -1 && colonIdx < text.length * 0.6) body = text.slice(colonIdx + 1).trim();
  body = body.replace(/,?\s+and\s+/gi, ", ").replace(/,?\s+or\s+/gi, ", ");
  const parts = body.split(/[,;]/).map((p) => p.trim().replace(/\.$/, "").trim()).filter((p) => p.length > 0);
  if (parts.length < 2) return [];
  const avgLen = parts.reduce((sum, p) => sum + p.length, 0) / parts.length;
  if (avgLen > 80) return [];
  return parts;
}
