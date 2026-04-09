/**
 * Policy loading orchestration.
 *
 * Extracted from renderer.ts. Handles the full lifecycle of opening
 * an existing policy: definition export, metadata loading, progressive
 * import recovery, build asset loading, fidelity reports, test loading,
 * and the initial agent greeting.
 */
import type { PolicyService } from "../services/policy-service";
import { ACTIVE_BUILD_STATUSES, SECTION_IMPORT_POLL_INTERVAL_MS, SECTION_IMPORT_MAX_POLL_ATTEMPTS } from "../services/policy-service";
import type { ChatService } from "../services/chat-service";
import type { BuildOrchestrator } from "../services/build-orchestrator";
import type { DocumentPreviewHandle as DocumentPreview } from "../components/DocumentPreviewPanel";
import type { ChatPanelHandle as ChatPanel } from "../components/ChatPanelComponent";
import type { TestPanelHandle as TestPanel } from "../components/TestPanel";
import type { ChatSessionManager } from "../services/chat-session-manager";
import { buildAssetsStore } from "../services/build-assets-store";
import { withTimeout } from "../utils/async";
import { buildSystemPrompt } from "../prompts/agent-system-prompt";
import { buildPolicyContext, rebuildContextIndex, getContextIndex, getKnownEntities, type PolicyStateAccessor } from "../state/policy-state";
import { serializeContextIndex } from "../services/context-index";
import { streamAgentMessage } from "../utils/agent-stream";
import { mapToolToActivityLabel } from "../utils/tool-labels";
import type { PolicyMetadata, PolicyLocalState, TestCaseWithResult, SectionImportState } from "../types";
import type { AutomatedReasoningPolicyDefinition } from "@aws-sdk/client-bedrock";
import { importSection, importMultipleSections, type SectionImportDeps } from './section-import';
import { wireSectionHandlers } from './section-wiring';

export interface PolicyLoaderDeps extends Pick<PolicyStateAccessor,
  | 'getPolicy' | 'setPolicy'
  | 'getLocalState' | 'setLocalState'
  | 'getDefinition' | 'setDefinition'
  | 'getBuildWorkflowId' | 'setBuildWorkflowId'
  | 'setTestCases' | 'setTestsWithResults'
  | 'setSourceDocumentText' | 'getSourceDocumentText'
  | 'persistLocalState' | 'updateSectionImportState'
> {
  policyService: PolicyService;
  buildOrchestrator: BuildOrchestrator;
  chatSessionMgr: ChatSessionManager;
  policyChatService: ChatService;
  chatPanel: ChatPanel;
  docPreview: DocumentPreview;
  testPanel: TestPanel;
  configureMcpTools: (service: ChatService) => Promise<void>;
  showScreen: (screenId: string) => void;
  buildSectionImportDeps: () => SectionImportDeps;
  /** Policy-bound UI for streaming — writes to the policy context regardless of active view. */
  policyUI?: import('../services/chat-session-manager').ChatSessionUI;
  /** Write the serialized context index to disk for the MCP subprocess. */
  writeContextIndexFile: (json: string) => Promise<void>;
}

export async function loadPolicy(policyArn: string, name: string, deps: PolicyLoaderDeps): Promise<void> {
  // Clear any active background polling from a previous policy
  deps.buildOrchestrator.clearAllPollingIntervals();
  deps.chatSessionMgr.clearTestSessions();

  const statusEl = deps.chatPanel.appendStatus("Opening your policy…");
  console.log("[loadPolicy] Starting for policy:", name, policyArn);

  // Step 1: Connect the chat service
  deps.chatPanel.updateStatus(statusEl, "Connecting to agent...");
  try {
    await deps.configureMcpTools(deps.policyChatService);
    await withTimeout(deps.policyChatService.connect(buildSystemPrompt()), 15_000, "policyChatService.connect");
    console.log("[loadPolicy] Chat service connected");
  } catch (err) {
    const errMsg = (err as Error).message;
    console.warn("[loadPolicy] Chat service connection failed (non-critical):", errMsg);
    // Log to debug export so we can diagnose MCP connection issues in packaged builds
    try { window.architect.logRendererEvent("mcp-connect-failed", { error: errMsg, stack: (err as Error).stack }, "error"); } catch { /* best-effort */ }
    deps.chatPanel.appendStatus("Warning: Agent connection failed. Chat will retry on first message.");
  }

  // Step 2: Export definition (critical)
  deps.chatPanel.updateStatus(statusEl, "Fetching policy definition...");
  let definition: AutomatedReasoningPolicyDefinition;
  try {
    definition = await withTimeout(deps.policyService.exportPolicyDefinition(policyArn), 30_000, "exportPolicyDefinition");
    console.log("[loadPolicy] Policy definition loaded — rules:", definition.rules?.length ?? 0, "variables:", definition.variables?.length ?? 0);
  } catch (err) {
    const msg = `Failed to load policy definition: ${(err as Error).message}`;
    console.error("[loadPolicy]", msg);
    deps.chatPanel.updateStatus(statusEl, msg, true);
    return;
  }
  deps.setDefinition(definition);

  const { ruleIds, variableNames } = getKnownEntities();
  deps.chatPanel.updateKnownEntities(ruleIds, variableNames);

  // Step 3: Load metadata
  deps.chatPanel.updateStatus(statusEl, "Loading metadata...");
  let metadata: PolicyMetadata = { policyArn, name };
  try {
    const metaJson = await window.architect.loadMetadata(policyArn);
    if (metaJson) { metadata = JSON.parse(metaJson); console.log("[loadPolicy] Metadata loaded from disk"); }
    else { console.log("[loadPolicy] No saved metadata found, using defaults"); }
  } catch (err) {
    console.warn("[loadPolicy] Metadata load failed:", (err as Error).message);
    deps.chatPanel.appendStatus("Warning: Could not read saved metadata. Starting with defaults.");
  }
  deps.setPolicy(metadata);

  // Step 3b: Load progressive import local state
  let localState: PolicyLocalState | null = null;
  try {
    const localJson = await window.architect.loadLocalState(policyArn);
    if (localJson) { localState = JSON.parse(localJson); console.log("[loadPolicy] Local state loaded — sections:", localState!.sections.length); }
  } catch (err) { console.warn("[loadPolicy] Local state load failed:", (err as Error).message); }

  // Initialize a default local state if none exists so that fidelity reports
  // and other assets can be cached on first open of an existing policy.
  if (!localState) {
    localState = {
      policyArn,
      policyName: name,
      documentPath: metadata.documentPath ?? "",
      sections: [],
      sectionImports: {},
      fidelityReports: {},
    };
    console.log("[loadPolicy] Initialized default local state for caching");
    deps.setLocalState(localState);
    await deps.persistLocalState();
  } else {
    deps.setLocalState(localState);
  }

  const hasProgressiveImport = localState && localState.sections.length > 0;
  const allSectionsImported = hasProgressiveImport && Object.values(localState!.sectionImports).every((s) => s.status === "completed");

  // Step 4: Load document
  if (hasProgressiveImport && !allSectionsImported) {
    await loadProgressiveImportMode(policyArn, localState!, deps);
  } else if (metadata.documentPath) {
    console.log("[loadPolicy] Loading source document:", metadata.documentPath);
    try {
      const text = await window.architect.readFileText(metadata.documentPath);
      deps.docPreview.loadDocument(text);
      deps.setSourceDocumentText(text);
      if (metadata.summarizedRules) deps.docPreview.setHighlightsFromSummary(metadata.summarizedRules);
      console.log("[loadPolicy] Source document loaded");
    } catch (err) {
      console.warn("[loadPolicy] Source document not found:", (err as Error).message);
      deps.chatPanel.appendStatus("Source document not found. Document preview is unavailable.");
    }
  } else {
    console.log("[loadPolicy] No document path — showing open-document prompt");
    deps.docPreview.showOpenPrompt("No source document loaded. Open a markdown file to see it here.", "Open Markdown File", async () => {
      try {
        const mdPath = await window.architect.openMarkdownDialog();
        if (mdPath) {
          const text = await window.architect.readFileText(mdPath);
          deps.docPreview.loadDocument(text);
          deps.setSourceDocumentText(text);
          metadata.documentPath = mdPath;
          deps.setPolicy(metadata);
          await window.architect.saveMetadata(policyArn, JSON.stringify(metadata));
        }
      } catch (err) { console.warn("[loadPolicy] Markdown file load failed:", (err as Error).message); deps.chatPanel.appendStatus("Could not load document. You can try again later."); }
    });
  }

  // Step 5: Policy is usable
  deps.chatPanel.updateStatus(statusEl, `Loaded policy: ${metadata.name}`);
  deps.chatPanel.setContext(metadata.name);
  console.log("[loadPolicy] Policy ready:", metadata.name);

  // Step 6: Load build assets, fidelity, tests, and send agent greeting.
  // This runs in the background so the UI is responsive immediately.
  // Each phase is best-effort — failures are logged but don't block the UI.
  loadBuildAssetsAndGreet(policyArn, statusEl, deps);
}

/**
 * Background work after the policy is usable: load build assets, seed caches,
 * apply fidelity report, load tests, build context index, and send the
 * initial agent greeting. Errors are caught and logged — never thrown.
 */
async function loadBuildAssetsAndGreet(policyArn: string, statusEl: HTMLElement, deps: PolicyLoaderDeps): Promise<void> {
  let staleFidelityReport = false;
  let fidelityBuildInProgress = false;
  try {
    const result = await deps.buildOrchestrator.loadLatestBuildAssets(policyArn);
    staleFidelityReport = result.staleFidelityReport;
    fidelityBuildInProgress = result.fidelityBuildInProgress;
  } catch (err) {
    console.warn("[loadPolicy] Build asset loading failed:", (err as Error).message);
    deps.chatPanel.appendStatus("Warning: Could not load build history.");
  }

  await seedLocalStateCache(policyArn, deps);
  await applyFidelityReportOrPrompt(deps, fidelityBuildInProgress, staleFidelityReport);
  await loadTests(policyArn, deps);

  deps.buildOrchestrator.pollBackgroundWorkflows(policyArn).catch((err) => {
    console.warn("[loadPolicy] Background workflow polling failed:", (err as Error).message);
  });

  await buildContextAndGreet(policyArn, statusEl, deps);
}

/**
 * Seed the local state cache from remote build data on first load.
 * If the local state has no record of the latest build, persist the
 * discovered fidelity report and scenarios so subsequent loads use the cache.
 */
async function seedLocalStateCache(policyArn: string, deps: PolicyLoaderDeps): Promise<void> {
  const currentLocalState = deps.getLocalState();
  const currentBuildWorkflowId = deps.getBuildWorkflowId();
  if (!currentLocalState || !currentBuildWorkflowId) return;

  const assets = buildAssetsStore.get();
  if (!currentLocalState.latestBuildWorkflowId) {
    currentLocalState.latestBuildWorkflowId = currentBuildWorkflowId;
    if (assets?.fidelityReport) {
      currentLocalState.fidelityReports[currentBuildWorkflowId] = assets.fidelityReport;
      currentLocalState.lastFidelityBuildWorkflowId = currentBuildWorkflowId;
      currentLocalState.lastFidelityReportTimestamp = Date.now();
      try { await window.architect.saveFidelityReport(policyArn, currentBuildWorkflowId, JSON.stringify(assets.fidelityReport)); } catch { /* best-effort */ }
    }
    if (assets?.policyScenarios && assets.policyScenarios.length > 0) {
      currentLocalState.policyScenarios = assets.policyScenarios;
      currentLocalState.lastScenariosBuildWorkflowId = currentBuildWorkflowId;
    }
    await deps.persistLocalState();
    console.log("[loadPolicy] Seeded local state cache from remote build:", currentBuildWorkflowId);
  }

  // Restore fidelity report from cache if the API didn't return one
  if (assets && !assets.fidelityReport) {
    const cachedReport = currentLocalState.fidelityReports[currentBuildWorkflowId];
    if (cachedReport) {
      assets.fidelityReport = cachedReport;
      assets.rawFidelityReport = null;
      buildAssetsStore.set(assets);
      console.log("[loadPolicy] Restored fidelity report from local state cache");
    } else {
      try {
        const rj = await window.architect.loadFidelityReport(policyArn, currentBuildWorkflowId);
        if (rj) {
          const r = JSON.parse(rj) as import("../types").FidelityReport;
          assets.fidelityReport = r;
          assets.rawFidelityReport = null;
          buildAssetsStore.set(assets);
          console.log("[loadPolicy] Restored fidelity report from disk cache");
        }
      } catch { /* best-effort */ }
    }
  }
}

/**
 * Apply the fidelity report to the document preview, or prompt the user
 * to generate one if none is available.
 */
async function applyFidelityReportOrPrompt(
  deps: PolicyLoaderDeps,
  fidelityBuildInProgress: boolean,
  staleFidelityReport: boolean,
): Promise<void> {
  if (!fidelityBuildInProgress) {
    try {
      const applied = await withTimeout(deps.buildOrchestrator.applyFidelityReport(), 60_000, "applyFidelityReport");
      if (!applied) {
        deps.chatPanel.appendMessage({
          id: `no-fidelity-${Date.now()}`, role: "assistant",
          content: "No grounding report is available for this policy yet. Would you like to generate one? This maps your policy rules and variables back to the source document.",
          cards: [{ type: "follow-up-prompt", label: "Generate grounding report", prompt: "Please start a new GENERATE_FIDELITY_REPORT build workflow for the current policy so the grounding analysis can map rules and variables to the source document." }],
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      console.warn("[loadPolicy] Fidelity report failed:", (err as Error).message);
    }
  } else {
    console.log("[loadPolicy] Fidelity build already in progress — background poller will handle it");
  }

  if (staleFidelityReport) {
    deps.docPreview.setStaleFidelityBanner(true);
  }
}

/**
 * Load test cases (with results if a build exists) into the test panel.
 */
async function loadTests(policyArn: string, deps: PolicyLoaderDeps): Promise<void> {
  const bwId = deps.getBuildWorkflowId();
  deps.testPanel.setLoading(true);
  try {
    if (bwId) {
      const results = await deps.policyService.loadTestsWithResults(policyArn, bwId);
      deps.testPanel.loadTests(results);
      deps.setTestsWithResults(results);
      deps.setTestCases(results);
      console.log("[loadPolicy] Tests with results loaded:", results.length);
    } else {
      const cases = await deps.policyService.listTestCases(policyArn);
      const asResults: import("../types").TestCaseWithResult[] = cases.map((tc) => ({ testCase: tc }));
      deps.testPanel.loadTests(asResults);
      deps.setTestsWithResults(asResults);
      deps.setTestCases(asResults);
      console.log("[loadPolicy] Test cases loaded (no build):", cases.length);
    }
  } catch (err) {
    console.warn("[loadPolicy] Test loading failed:", (err as Error).message);
    deps.setTestCases(null);
  } finally {
    deps.testPanel.setLoading(false);
  }
}

/**
 * Build the context index and send the initial agent greeting.
 */
async function buildContextAndGreet(
  policyArn: string,
  statusEl: HTMLElement,
  deps: PolicyLoaderDeps,
): Promise<void> {
  const currentPolicy = deps.getPolicy();
  const currentDefinition = deps.getDefinition();
  if (!currentPolicy || !currentDefinition) return;

  // Build the context index now that definition, document, and fidelity are loaded
  rebuildContextIndex();
  const contextIndex = getContextIndex();
  if (contextIndex) {
    try {
      const json = JSON.stringify(serializeContextIndex(contextIndex));
      await deps.writeContextIndexFile(json);
      console.log("[loadPolicy] Context index built and serialized");
    } catch (err) {
      console.warn("[loadPolicy] Failed to write context index file:", (err as Error).message);
    }
  }

  const policyContext = buildPolicyContext();
  const ruleCount = currentDefinition.rules?.length ?? 0;
  const varCount = currentDefinition.variables?.length ?? 0;
  const typeCount = currentDefinition.types?.length ?? 0;

  const initialPrompt = [
    'The user just opened this policy. Respond using well-structured markdown with the following sections:',
    '',
    '## Policy summary',
    'Give a high-level description of what the policy covers in at most two short paragraphs.',
    '',
    '## Extracted definitions',
    `Include the following stats exactly as a bulleted list:`,
    `- **Rules:** ${ruleCount}`,
    `- **Variables:** ${varCount}`,
    `- **Types:** ${typeCount}`,
    '',
    '## Quality report',
    'Summarize the issues from the quality report (if any). If there are no issues, say the policy looks healthy.',
    '',
    'Finally, suggest a single next action the user should take (e.g., reviewing rules, running tests,',
    'or fixing quality issues). Remember to emit the appropriate card (rule, next-steps, follow-up-prompt, etc.)',
    'following the Chat Cards Protocol in your instructions.',
  ].join('\n');

  const ui = deps.policyUI ?? deps.chatPanel;
  deps.chatPanel.updateStatus(statusEl, "");

  const streamAnchor = ui.startStreaming();
  streamAgentMessage(
    deps.policyChatService,
    { pushStreamChunk: (text) => ui.pushStreamChunk(text), noteToolCallStarted: () => ui.noteToolCallStarted(), noteToolActivity: (title) => ui.noteToolActivity(mapToolToActivityLabel(title)) },
    initialPrompt,
    policyContext,
    { logPrefix: 'loadPolicy' },
  ).then(() => { ui.endStreaming(); })
    .catch((err) => { ui.abortStreaming(streamAnchor); console.warn("[loadPolicy] Initial agent prompt failed:", (err as Error).message); });
}

/** Handle progressive import mode — accordion UI with section recovery. */
async function loadProgressiveImportMode(policyArn: string, localState: PolicyLocalState, deps: PolicyLoaderDeps): Promise<void> {
  console.log("[loadPolicy] Progressive import mode — showing accordion");
  const sectionImportDeps = deps.buildSectionImportDeps();

  try {
    const text = await window.architect.readFileText(localState.documentPath);
    deps.setSourceDocumentText(text);
    deps.docPreview.loadSections(localState.sections, localState.sectionImports);
    wireSectionHandlers(deps.docPreview, {
      getLocalState: deps.getLocalState,
      getSourceDocumentText: deps.getSourceDocumentText,
      persistLocalState: deps.persistLocalState,
      appendStatus: (text) => deps.chatPanel.appendStatus(text),
      importSection: (section) => importSection(section, sectionImportDeps),
      importMultipleSections: (sections) => importMultipleSections(sections, sectionImportDeps),
    });
  } catch (err) {
    console.warn("[loadPolicy] Source document not found for accordion:", (err as Error).message);
    deps.chatPanel.appendStatus("Source document not found. Document preview is unavailable.");
  }

  // Recover in_progress and timed_out sections
  const recoverableSections = Object.values(localState.sectionImports).filter(
    (s) => (s.status === "in_progress" || s.status === "timed_out") && s.buildWorkflowId,
  );
  for (const sectionState of recoverableSections) {
    // Each section recovery is independent — don't let one failure block others
    await recoverSection(policyArn, localState, sectionState, deps);
  }
}

/**
 * Recover a single section import that was in_progress or timed_out.
 * If the build is still active, polls in the background (fire-and-forget).
 */
async function recoverSection(
  policyArn: string,
  localState: PolicyLocalState,
  sectionState: SectionImportState,
  deps: PolicyLoaderDeps,
): Promise<void> {
  const sectionId = sectionState.sectionId;
  const buildWorkflowId = sectionState.buildWorkflowId!;
  console.log("[loadPolicy] Recovering", sectionState.status, "section:", sectionId, "build:", buildWorkflowId);

  try {
    const build = await deps.policyService.getBuild(policyArn, buildWorkflowId);

    if (ACTIVE_BUILD_STATUSES.has(build.status)) {
      // Build still running — poll in the background
      deps.chatPanel.appendStatus(`Resuming import for section — build still in progress…`);
      deps.docPreview.updateSectionState(sectionId, sectionState);
      pollSectionBuildToCompletion(policyArn, localState, sectionId, buildWorkflowId, deps);
      return;
    }

    if (build.status === "COMPLETED") {
      await applySectionBuildResult(policyArn, localState, sectionId, build.buildWorkflowId, deps);
      console.log("[loadPolicy] Recovered completed section:", sectionId);
    } else {
      await markSectionFailed(sectionId, deps);
      console.log("[loadPolicy] Section build failed/cancelled:", sectionId, build.status);
    }
  } catch (err) {
    console.warn("[loadPolicy] Section recovery failed:", sectionId, (err as Error).message);
    await markSectionFailed(sectionId, deps);
  }
}

/**
 * Poll an active section build in the background and apply the result when done.
 * Fire-and-forget — errors are caught and logged.
 */
function pollSectionBuildToCompletion(
  policyArn: string,
  localState: PolicyLocalState,
  sectionId: string,
  buildWorkflowId: string,
  deps: PolicyLoaderDeps,
): void {
  deps.policyService.pollBuild(policyArn, buildWorkflowId, SECTION_IMPORT_POLL_INTERVAL_MS, SECTION_IMPORT_MAX_POLL_ATTEMPTS)
    .then(async (finished) => {
      if (finished.status === "COMPLETED") {
        await applySectionBuildResult(policyArn, localState, sectionId, finished.buildWorkflowId, deps);
      } else {
        await markSectionFailed(sectionId, deps);
      }
    })
    .catch(async (err) => {
      console.warn("[loadPolicy] Recovery polling failed:", (err as Error).message);
      await markSectionFailed(sectionId, deps);
    });
}

/**
 * Apply a completed section build: load assets, update definition, mark section completed.
 */
async function applySectionBuildResult(
  policyArn: string,
  localState: PolicyLocalState,
  sectionId: string,
  buildWorkflowId: string,
  deps: PolicyLoaderDeps,
): Promise<void> {
  await deps.buildOrchestrator.loadBuildAssets(policyArn, buildWorkflowId);
  deps.setBuildWorkflowId(buildWorkflowId);
  const assets = buildAssetsStore.get();
  if (assets?.rawPolicyDefinition && "policyDefinition" in assets.rawPolicyDefinition) {
    deps.setDefinition(assets.rawPolicyDefinition.policyDefinition ?? null);
  }
  await deps.updateSectionImportState(sectionId, { status: "completed", buildWorkflowId });
  localState.latestBuildWorkflowId = buildWorkflowId;
  deps.docPreview.updateSectionState(sectionId, deps.getLocalState()!.sectionImports[sectionId]);
}

/** Mark a section as failed and update the UI. */
async function markSectionFailed(sectionId: string, deps: PolicyLoaderDeps): Promise<void> {
  await deps.updateSectionImportState(sectionId, { status: "failed" });
  deps.docPreview.updateSectionState(sectionId, deps.getLocalState()!.sectionImports[sectionId]);
}
