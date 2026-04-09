/**
 * Centralized application state for the loaded policy.
 *
 * Built on an observable store pattern (matching buildAssetsStore) so that
 * any consumer can subscribe to state changes. The free-standing getter/setter
 * functions delegate to a singleton PolicyStore instance for backward
 * compatibility — existing call sites don't need to change.
 */
import type { PolicyMetadata, TestCaseWithResult, PolicyLocalState, SectionImportState } from "../types";
import { toAppDefinition } from "../utils/policy-definition";
import type { AutomatedReasoningPolicyDefinition } from "@aws-sdk/client-bedrock";
import { buildAssetsStore } from "../services/build-assets-store";
import {
  buildContextIndex,
  buildPolicyOutline,
  buildTaskContext,
  estimateContextSize,
  DEFAULT_COMPACT_THRESHOLD_BYTES,
  type ContextIndex,
} from "../services/context-index";
import { parseMarkdownSections, subdivideLargeSections } from "../utils/markdown-sections";

// ── Store shape ──

export interface PolicyStateSnapshot {
  policy: PolicyMetadata | null;
  localState: PolicyLocalState | null;
  definition: AutomatedReasoningPolicyDefinition | null;
  buildWorkflowId: string | null;
  testCases: TestCaseWithResult[] | null;
  testsWithResults: TestCaseWithResult[];
  sourceDocumentText: string | null;
  contextIndex: ContextIndex | null;
}

export type PolicyStateListener = (snapshot: PolicyStateSnapshot) => void;

// ── Observable store ──

export class PolicyStore {
  private state: PolicyStateSnapshot = {
    policy: null,
    localState: null,
    definition: null,
    buildWorkflowId: null,
    testCases: null,
    testsWithResults: [],
    sourceDocumentText: null,
    contextIndex: null,
  };

  private listeners: PolicyStateListener[] = [];

  // ── Getters ──

  getPolicy(): PolicyMetadata | null { return this.state.policy; }
  getLocalState(): PolicyLocalState | null { return this.state.localState; }
  getDefinition(): AutomatedReasoningPolicyDefinition | null { return this.state.definition; }
  getBuildWorkflowId(): string | null { return this.state.buildWorkflowId; }
  getTestCases(): TestCaseWithResult[] | null { return this.state.testCases; }
  getTestsWithResults(): TestCaseWithResult[] { return this.state.testsWithResults; }
  getSourceDocumentText(): string | null { return this.state.sourceDocumentText; }
  getContextIndex(): ContextIndex | null { return this.state.contextIndex; }

  /** Return a shallow copy of the full state snapshot. */
  getSnapshot(): PolicyStateSnapshot { return { ...this.state }; }

  // ── Setters (each notifies listeners) ──

  setPolicy(policy: PolicyMetadata | null): void { this.state.policy = policy; this.notify(); }
  setLocalState(state: PolicyLocalState | null): void { this.state.localState = state; this.notify(); }
  setDefinition(def: AutomatedReasoningPolicyDefinition | null): void { this.state.definition = def; this.notify(); }
  setBuildWorkflowId(id: string | null): void { this.state.buildWorkflowId = id; this.notify(); }
  setTestCases(cases: TestCaseWithResult[] | null): void { this.state.testCases = cases; this.notify(); }
  setTestsWithResults(results: TestCaseWithResult[]): void { this.state.testsWithResults = results; this.notify(); }
  setSourceDocumentText(text: string | null): void { this.state.sourceDocumentText = text; this.notify(); }
  setContextIndex(index: ContextIndex | null): void { this.state.contextIndex = index; this.notify(); }

  // ── Subscriptions ──

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(listener: PolicyStateListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((fn) => fn !== listener);
    };
  }

  private notify(): void {
    const snapshot = this.getSnapshot();
    for (const fn of this.listeners) {
      fn(snapshot);
    }
  }
}

/** Singleton store instance — import this for direct store access or subscriptions. */
export const policyStore = new PolicyStore();

// ── Free-standing accessors (backward compatibility) ──
// All existing call sites use these. They delegate to the singleton store.

export function getPolicy(): PolicyMetadata | null { return policyStore.getPolicy(); }
export function getLocalState(): PolicyLocalState | null { return policyStore.getLocalState(); }
export function getDefinition(): AutomatedReasoningPolicyDefinition | null { return policyStore.getDefinition(); }
export function getBuildWorkflowId(): string | null { return policyStore.getBuildWorkflowId(); }
export function getTestCases(): TestCaseWithResult[] | null { return policyStore.getTestCases(); }
export function getTestsWithResults(): TestCaseWithResult[] { return policyStore.getTestsWithResults(); }
export function getSourceDocumentText(): string | null { return policyStore.getSourceDocumentText(); }
export function getContextIndex(): ContextIndex | null { return policyStore.getContextIndex(); }

export function setPolicy(policy: PolicyMetadata | null): void { policyStore.setPolicy(policy); }
export function setLocalState(state: PolicyLocalState | null): void { policyStore.setLocalState(state); }
export function setDefinition(def: AutomatedReasoningPolicyDefinition | null): void { policyStore.setDefinition(def); }
export function setBuildWorkflowId(id: string | null): void { policyStore.setBuildWorkflowId(id); }
export function setTestCases(cases: TestCaseWithResult[] | null): void { policyStore.setTestCases(cases); }
export function setTestsWithResults(results: TestCaseWithResult[]): void { policyStore.setTestsWithResults(results); }
export function setSourceDocumentText(text: string | null): void { policyStore.setSourceDocumentText(text); }

// ── PolicyStateAccessor (bundled accessor object for dependency injection) ──

/**
 * Bundled state accessor object.
 *
 * Workflows and orchestrators declare their deps as
 * `Pick<PolicyStateAccessor, 'getPolicy' | 'getDefinition' | …>` instead of
 * repeating individual function signatures. The renderer wires them once via
 * `createStateAccessor()`.
 */
export interface PolicyStateAccessor {
  getPolicy: () => PolicyMetadata | null;
  setPolicy: (p: PolicyMetadata | null) => void;
  getLocalState: () => PolicyLocalState | null;
  setLocalState: (s: PolicyLocalState | null) => void;
  getDefinition: () => AutomatedReasoningPolicyDefinition | null;
  setDefinition: (def: AutomatedReasoningPolicyDefinition | null) => void;
  getBuildWorkflowId: () => string | null;
  setBuildWorkflowId: (id: string | null) => void;
  getTestCases: () => TestCaseWithResult[] | null;
  setTestCases: (cases: TestCaseWithResult[] | null) => void;
  getTestsWithResults: () => TestCaseWithResult[];
  setTestsWithResults: (results: TestCaseWithResult[]) => void;
  getSourceDocumentText: () => string | null;
  setSourceDocumentText: (text: string | null) => void;
  persistLocalState: () => Promise<void>;
  updateSectionImportState: (sectionId: string, patch: Partial<SectionImportState>) => Promise<void>;
}

/** Create a PolicyStateAccessor bound to the singleton store. */
export function createStateAccessor(): PolicyStateAccessor {
  return {
    getPolicy, setPolicy,
    getLocalState, setLocalState,
    getDefinition, setDefinition,
    getBuildWorkflowId, setBuildWorkflowId,
    getTestCases, setTestCases,
    getTestsWithResults, setTestsWithResults,
    getSourceDocumentText, setSourceDocumentText,
    persistLocalState, updateSectionImportState,
  };
}

// ── Derived state helpers ──

/**
 * Build the policy context object sent with every agent prompt.
 * Returns undefined if no policy is loaded.
 *
 * Automatically selects compact mode when the estimated context size
 * exceeds the threshold, or when forced via ARCHITECT_CONTEXT_MODE=compact.
 *
 * @param targetTest Optional test case to pre-select relevant context for (compact mode only).
 */
export function buildPolicyContext(
  targetTest?: TestCaseWithResult,
): Record<string, unknown> | undefined {
  const currentPolicy = policyStore.getPolicy();
  const currentDefinition = policyStore.getDefinition();
  if (!currentPolicy || !currentDefinition) return undefined;
  const assets = buildAssetsStore.get();
  const def = toAppDefinition(currentDefinition);
  const currentSourceDocumentText = policyStore.getSourceDocumentText();
  const currentTestCases = policyStore.getTestCases();
  const currentLocalState = policyStore.getLocalState();
  const currentContextIndex = policyStore.getContextIndex();

  // Determine context mode
  const forceCompact = typeof process !== "undefined" && process.env?.ARCHITECT_CONTEXT_MODE === "compact";
  const threshold = DEFAULT_COMPACT_THRESHOLD_BYTES;
  const estimatedSize = estimateContextSize(def, currentSourceDocumentText);
  const useCompact = forceCompact || estimatedSize > threshold;

  if (useCompact && currentContextIndex) {
    // Compact mode: structural outline + task-relevant context
    const outline = buildPolicyOutline(
      currentContextIndex,
      currentPolicy.policyArn,
      assets?.qualityReport ?? [],
      currentLocalState?.sectionImports
        ? Object.fromEntries(
          Object.entries(currentLocalState.sectionImports)
            .map(([id, s]) => [id, s.status]),
        )
        : undefined,
    );

    const taskContext = targetTest
      ? buildTaskContext(currentContextIndex, targetTest)
      : null;

    return {
      ...outline,
      ...(taskContext && { taskContext }),
      ...(currentTestCases && currentTestCases.length > 0 && { testCases: currentTestCases }),
      ...(assets?.policyScenarios && assets.policyScenarios.length > 0 && {
        satisfiableScenarios: assets.policyScenarios.map((s) => s.alternateExpression),
      }),
    };
  }

  // Full mode: send everything (existing behavior)
  return {
    policyArn: currentPolicy.policyArn,
    policyDefinition: currentDefinition,
    ...(currentSourceDocumentText && { sourceDocumentText: currentSourceDocumentText }),
    ...(assets?.qualityReport && { qualityReport: assets.qualityReport }),
    ...(currentTestCases && currentTestCases.length > 0 && { testCases: currentTestCases }),
    ...(assets?.policyScenarios && assets.policyScenarios.length > 0 && {
      satisfiableScenarios: assets.policyScenarios.map((s) => s.alternateExpression),
    }),
  };
}

/**
 * Rebuild the context index from current state.
 * Call this after policy load, definition change, fidelity report generation,
 * or document reload.
 */
export function rebuildContextIndex(): void {
  const currentDefinition = policyStore.getDefinition();
  if (!currentDefinition) {
    policyStore.setContextIndex(null);
    return;
  }
  const def = toAppDefinition(currentDefinition);
  const docText = policyStore.getSourceDocumentText();
  const sections = docText
    ? subdivideLargeSections(parseMarkdownSections(docText))
    : [];
  const fidelity = buildAssetsStore.get()?.fidelityReport ?? null;

  policyStore.setContextIndex(
    buildContextIndex(def, docText, sections, fidelity, policyStore.getTestsWithResults()),
  );
}

/**
 * Get known entity names from the current definition for chat panel linkification.
 */
export function getKnownEntities(): { ruleIds: string[]; variableNames: string[] } {
  const currentDefinition = policyStore.getDefinition();
  if (!currentDefinition) return { ruleIds: [], variableNames: [] };
  const def = toAppDefinition(currentDefinition);
  return {
    ruleIds: def.rules?.map((r) => r.ruleId) ?? [],
    variableNames: def.variables?.map((v) => v.name) ?? [],
  };
}

// ── Local state persistence ──

/** Persist the current local state to ~/.ARchitect/. No-op if no state loaded. */
export async function persistLocalState(): Promise<void> {
  const currentLocalState = policyStore.getLocalState();
  if (!currentLocalState) return;
  try {
    await window.architect.saveLocalState(
      currentLocalState.policyArn,
      JSON.stringify(currentLocalState),
    );
  } catch (err) {
    console.warn("[persistLocalState] Failed:", (err as Error).message);
  }
}

/** Update a section's import state in memory and persist. */
export async function updateSectionImportState(
  sectionId: string,
  patch: Partial<SectionImportState>,
): Promise<void> {
  const currentLocalState = policyStore.getLocalState();
  if (!currentLocalState) return;
  const existing = currentLocalState.sectionImports[sectionId] ?? {
    sectionId,
    status: "not_started" as const,
  };
  currentLocalState.sectionImports[sectionId] = {
    ...existing,
    ...patch,
    lastUpdatedAt: new Date().toISOString(),
  };
  await persistLocalState();
}
