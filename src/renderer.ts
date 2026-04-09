/**
 * Renderer entry point — wires up the UI components, services,
 * and handles the initialization + workspace workflows.
 */
import "./styles.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { applyMode, Mode } from "@cloudscape-design/global-styles";
import { App, type AppHandle, type Screen } from "./App";
import type { TestPanelHandle } from "./components/TestPanel";
import type { DocumentPreviewHandle } from "./components/DocumentPreviewPanel";
import type { ChatPanelHandle } from "./components/ChatPanelComponent";
import { PolicyService } from "./services/policy-service";
import type { ChatService } from "./services/chat-service";
import type { DocumentSection } from "./types";
import { toAppDefinition } from "./utils/policy-definition";
import { buildAssetsStore } from "./services/build-assets-store";
import { parseMarkdownSections } from "./utils/markdown-sections";
import { createCardActionHandler } from "./workflows/card-actions";
import { wireTestPanelHandlers, refreshTestsAfterPolicyChange as refreshTestsWorkflow, type TestWorkflowDeps } from "./workflows/test-workflows";
import { loadPolicy as loadPolicyWorkflow } from "./workflows/policy-loader";
import { importSection as importSectionWorkflow, importMultipleSections as importMultipleSectionsWorkflow, type SectionImportDeps } from "./workflows/section-import";
import { createSendMessageHandler, type ChatMessageDeps } from "./workflows/chat-message";
import { wireSectionHandlers } from "./workflows/section-wiring";
import * as State from "./state/policy-state";
import { createStateAccessor } from "./state/policy-state";
import { BuildOrchestrator } from "./services/build-orchestrator";
import { ChatSessionManager } from "./services/chat-session-manager";
import type { ArchitectAPI } from "./types/preload";
import { requireElement } from "./utils/dom";
import { createChatPanelStub, createDocPreviewStub, createTestPanelStub } from "./utils/panel-stubs";

declare global {
  interface Window {
    architect: ArchitectAPI;
    __appHandle?: AppHandle;
  }
}

// ── Services ──
const region = window.architect.getRegion();
const policyService = new PolicyService({ region });

// ── Chat session manager ──
// The policy-bound UI is created lazily once the ChatPanelComponent provides its router.
// Until then, these closures delegate to chatPanel which is set during workspace init.
let policyBoundUI: import('./services/chat-session-manager').ChatSessionUI | null = null;

const chatSessionMgr = new ChatSessionManager({
  startStreaming: () => (policyBoundUI ?? chatPanel).startStreaming(),
  pushStreamChunk: (text) => (policyBoundUI ?? chatPanel).pushStreamChunk(text),
  endStreaming: () => (policyBoundUI ?? chatPanel).endStreaming(),
  abortStreaming: (anchor) => (policyBoundUI ?? chatPanel).abortStreaming(anchor),
  appendStatus: (text) => (policyBoundUI ?? chatPanel).appendStatus(text),
  clearMessages: () => (policyBoundUI ?? chatPanel).clearMessages(),
  saveMessages: () => (policyBoundUI ?? chatPanel).saveMessages(),
  restoreMessages: (html) => (policyBoundUI ?? chatPanel).restoreMessages(html),
  noteToolCallStarted: () => (policyBoundUI ?? chatPanel).noteToolCallStarted(),
  noteToolActivity: (label: string) => (policyBoundUI ?? chatPanel).noteToolActivity(label),
  streamGeneration: () => 0,
}, {
  getPolicyArn: () => State.getPolicy()?.policyArn ?? null,
  getPolicyContext: () => {
    const base = State.buildPolicyContext();
    if (!base) return undefined;
    const buildWorkflowId = State.getBuildWorkflowId();
    return buildWorkflowId ? { ...base, buildWorkflowId } : base;
  },
}, {
  getMcpServerPath: () => window.architect.getMcpServerPath(),
  getNodeCommand: () => window.architect.getNodeCommand(),
  getApprovalCodeFilePath: () => window.architect.getApprovalCodeFilePath(),
  getContextIndexFilePath: () => window.architect.getContextIndexFilePath(),
  getRegion: () => region,
});

// Local aliases for backward compatibility during migration
const policyChatService = chatSessionMgr.policyChatService;
const configureMcpTools = (service: ChatService) => chatSessionMgr.configureMcpTools(service);

// ── UI Components (initialized lazily when workspace DOM is ready) ──
let chatPanel: ChatPanelHandle;
let docPreview: DocumentPreviewHandle;
let testPanel: TestPanelHandle;
let uiInitialized = false;

// ── Build orchestrator ──
// ── Default ACP update handler (active when no prompt is in flight) ──

// ── State ──
// All mutable state lives in src/state/policy-state.ts.
// Renderer reads/writes through State.getX() / State.setX().
const stateAccessor = createStateAccessor();
const persistLocalState = State.persistLocalState;
const updateSectionImportState = State.updateSectionImportState;

// ── Build orchestrator ──
const buildOrchestrator = new BuildOrchestrator(policyService, {
  docSetLoading: (loading, msg) => { if (uiInitialized) docPreview.setLoading(loading, msg); },
  docSetHighlights: (report) => { if (uiInitialized) docPreview.setHighlightsFromFidelityReport(report); },
  docSetRegenerateVisible: (visible) => { if (uiInitialized) docPreview.setRegenerateButtonVisible(visible); },
  docSetStaleBanner: (visible) => { if (uiInitialized) docPreview.setStaleFidelityBanner(visible); },
  testSetLoading: (loading, msg) => { if (uiInitialized) testPanel.setLoading(loading, msg); },
  testLoadTests: (results) => { if (uiInitialized) testPanel.loadTests(results); },
  chatAppendStatus: (text) => { if (uiInitialized) return chatPanel.appendStatus(text); return document.createElement("div"); },
}, {
  ...stateAccessor,
  saveFidelityReport: (policyArn, buildWorkflowId, json) => window.architect.saveFidelityReport(policyArn, buildWorkflowId, json),
  saveScenarios: (policyArn, json) => window.architect.saveScenarios(policyArn, json),
});

// ── Build orchestration (delegated to BuildOrchestrator) ──
const loadBuildAssets = (policyArn: string, buildWorkflowId: string) => buildOrchestrator.loadBuildAssets(policyArn, buildWorkflowId);
const pollBackgroundWorkflows = (policyArn: string, skipBuildTypes?: ReadonlySet<string>) => buildOrchestrator.pollBackgroundWorkflows(policyArn, skipBuildTypes);
const generateFidelityReport = () => buildOrchestrator.generateFidelityReport();

// ── Screen management ──
// All screens are now React-rendered in #react-root.
const screenIdMap: Record<string, Screen> = {
  "landing-screen": "landing",
  "building-screen": "building",
  "workspace-screen": "workspace",
};

// Temporary migration bridge — returns the React App's imperative handle.
// This goes away once all screens are React components.
function getAppHandle(): AppHandle | null {
  return window.__appHandle ?? null;
}

// Promise gate for workspace initialization — resolves when onReady fires
let workspaceReadyPromise: Promise<void> | null = null;
let resolveWorkspaceReady: (() => void) | null = null;

function showScreen(screenId: string): void {
  const reactScreen = screenIdMap[screenId];
  if (reactScreen) {
    // When transitioning to workspace, set up the ready gate
    if (reactScreen === "workspace" && !uiInitialized) {
      workspaceReadyPromise = new Promise((resolve) => {
        resolveWorkspaceReady = resolve;
      });
    }
    getAppHandle()?.setScreen(reactScreen);
  }
}

/** Called exclusively from WorkspaceLayout.onReady — the single trigger for UI init. */
function onWorkspaceReady(): void {
  if (!uiInitialized) {
    initializeWorkspaceUI();
  }
  resolveWorkspaceReady?.();
  resolveWorkspaceReady = null;
  workspaceReadyPromise = null;
}

// ── Workspace button handlers (wired after workspace DOM is ready) ──

// Dev shortcut: Ctrl/Cmd+Shift+D jumps straight to workspace for chat testing
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "D") {
    e.preventDefault();
    showScreen("workspace-screen");
  }
});


// ── Section import (workflows in src/workflows/section-import.ts) ──

function buildSectionImportDeps(): SectionImportDeps {
  return {
    ...stateAccessor,
    policyService,
    policyChatService,
    chatPanelAppendStatus: (text) => (policyBoundUI ?? chatPanel).appendStatus(text),
    chatPanelStartStreaming: () => (policyBoundUI ?? chatPanel).startStreaming(),
    chatPanelPushStreamChunk: (text) => (policyBoundUI ?? chatPanel).pushStreamChunk(text),
    chatPanelEndStreaming: () => (policyBoundUI ?? chatPanel).endStreaming(),
    chatPanelAbortStreaming: (anchor) => (policyBoundUI ?? chatPanel).abortStreaming(anchor),
    chatPanelUpdateKnownEntities: (ruleIds, varNames) => chatPanel.updateKnownEntities(ruleIds, varNames),
    docPreviewUpdateSectionState: (id, state) => docPreview.updateSectionState(id, state),
    createImportDialog: () => {
      // Bridge: return a SectionImportDialogHandle that drives the React modal
      const dialogHandle: import("./workflows/section-import").SectionImportDialogHandle = {
        onSuggestInstructions: null,
        onConfirm: null,
        show: (sectionTitle: string) => {
          const handle = getAppHandle();
          if (!handle) return;
          handle.showSectionImport(
            sectionTitle,
            (instructions: string) => { dialogHandle.onConfirm?.(instructions); },
            () => new Promise<string>((resolve, reject) => {
              if (!dialogHandle.onSuggestInstructions) { reject(new Error("No suggest handler")); return; }
              dialogHandle.onSuggestInstructions((result: string) => resolve(result));
            }),
          );
        },
      };
      return dialogHandle;
    },
    configureMcpTools, loadBuildAssets, pollBackgroundWorkflows,
  };
}

function importSection(section: DocumentSection): void {
  importSectionWorkflow(section, buildSectionImportDeps());
}

function importMultipleSections(sections: DocumentSection[]): void {
  importMultipleSectionsWorkflow(sections, buildSectionImportDeps());
}

async function handleNewPolicy(): Promise<void> {
  getAppHandle()?.showNewPolicyForm();
}

async function handleCreatePolicy(name: string, filePath: string, maxLevel: number): Promise<void> {
  const handle = getAppHandle();
  if (!handle) {
    console.error("[handleCreatePolicy] React app handle not available");
    return;
  }
  handle.setBuildingState({ title: "Creating policy…", statusText: "Reading document", error: null });
  showScreen("building-screen");

    try {
      // 1. Read document and parse sections
      const text = await window.architect.readFileText(filePath);
      const sections = parseMarkdownSections(text, maxLevel);
      console.log("[handleNewPolicy] Parsed", sections.length, "sections from document");

      // 2. Create empty policy
      handle.setBuildingState({ statusText: "Creating policy resource…" });
      const policyArn = await policyService.createPolicy(name);
      console.log("[handleNewPolicy] Policy created:", policyArn);

      // 3. Initialize local state
      const sectionImports: Record<string, import("./types").SectionImportState> = {};
      for (const s of sections) {
        sectionImports[s.id] = { sectionId: s.id, status: "not_started" };
      }
      State.setLocalState({
        policyArn,
        policyName: name,
        documentPath: filePath,
        sections,
        sectionImports,
        fidelityReports: {},
      });

      // 4. Persist local state + metadata
      await persistLocalState();
      State.setPolicy({ policyArn, name, documentPath: filePath });
      await window.architect.saveMetadata(policyArn, JSON.stringify(State.getPolicy()));

      // 5. Set app state
      State.setDefinition(null);
      State.setBuildWorkflowId(null);
      State.setSourceDocumentText(text);
      State.setTestsWithResults([]);
      State.setTestCases([]);

      // 6. Transition to workspace (React renders WorkspaceLayout)
      showScreen("workspace-screen");

      // 7. Wait for workspace DOM to be ready (onReady fires from WorkspaceLayout)
      if (workspaceReadyPromise) await workspaceReadyPromise;

      // 8. Load document preview in accordion mode
      docPreview.loadSections(sections, sectionImports, maxLevel);
      wireSectionHandlers(docPreview, {
        getLocalState: () => State.getLocalState(),
        getSourceDocumentText: () => State.getSourceDocumentText(),
        persistLocalState,
        appendStatus: (text) => chatPanel.appendStatus(text),
        importSection,
        importMultipleSections,
      });

      // 8. Show empty state guidance in test and chat panels
      testPanel.loadTests([]);
      chatPanel.setContext(name);
      chatPanel.appendMessage({
        id: `welcome-${Date.now()}`,
        role: "assistant",
        content: "Your policy has been created. Select a section from the document preview and click **Import** to start building your policy. Each section will be processed individually so you can review the results as you go.",
        timestamp: Date.now(),
      });

      console.log("[handleNewPolicy] Workspace ready with", sections.length, "sections");

    } catch (err) {
      console.error("[handleCreatePolicy] Failed:", (err as Error).message);
      handle.setBuildingState({
        title: "Something went wrong",
        error: (err as Error).message,
      });
    }
}

export async function loadPolicy(policyArn: string, name: string): Promise<void> {
  // Guard for test harness: tests call loadPolicy directly with DOM already set up.
  // In production, onWorkspaceReady handles initialization before this is called.
  if (!uiInitialized) initializeWorkspaceUI();
  return loadPolicyWorkflow(policyArn, name, {
    ...stateAccessor,
    policyService, buildOrchestrator, chatSessionMgr, policyChatService, chatPanel, docPreview, testPanel,
    configureMcpTools, showScreen,
    buildSectionImportDeps,
    policyUI: policyBoundUI ?? undefined,
    writeContextIndexFile: async (json: string) => {
      await window.architect.writeContextIndex(json);
    },
  });
}

async function handleOpenPolicy(): Promise<void> {
  console.log("[handleOpenPolicy] Opening policy picker");
  getAppHandle()?.showPolicyPicker();
}

async function handlePolicySelected(policyArn: string, name: string): Promise<void> {
  console.log("[handlePolicySelected] Policy selected:", name, policyArn);
  showScreen("workspace-screen");
  // Wait for workspace DOM to be ready before accessing panel components
  if (workspaceReadyPromise) await workspaceReadyPromise;
  try {
    await loadPolicy(policyArn, name);
  } catch (err) {
    console.error("[handlePolicySelected] loadPolicy threw:", (err as Error).message);
    chatPanel.appendStatus(`Failed to open policy: ${(err as Error).message}`);
  }
}

// ── React root (Cloudscape migration) ──
// Mounted on #react-root. All screens render here.

/**
 * Initialize legacy UI components after the workspace DOM is rendered by React.
 * Called once via the onWorkspaceReady callback from WorkspaceLayout.
 */
function initializeWorkspaceUI(): void {
  if (uiInitialized) return;
  uiInitialized = true;

  // chatPanel, docPreview, and testPanel are set via React component onHandle callbacks.
  // Safety net: create no-op stubs if handles haven't been provided yet
  // (e.g. test harness calls loadPolicy before React mounts).
  if (!chatPanel) chatPanel = createChatPanelStub();
  if (!docPreview) docPreview = createDocPreviewStub();
  if (!testPanel) testPanel = createTestPanelStub();

  // Wire workspace button handlers
  const refreshBtn = document.getElementById("btn-refresh-tests");
  if (refreshBtn) refreshBtn.addEventListener("click", () => testPanel.onRefreshTests?.());

  // Wire chat message handling
  const chatMessageDeps: ChatMessageDeps = {
    chatSessionMgr,
    getTestChatService: () => chatSessionMgr.testChatService,
    getSelectedTest: () => {
      const testId = chatSessionMgr.activeTestId;
      if (!testId) return undefined;
      return State.getTestsWithResults().find(
        (t) => t.testCase?.testCaseId === testId,
      );
    },
    refreshTestsAfterPolicyChange: () => refreshTestsAfterPolicyChange(),
    writeContextIndexFile: async (json: string) => {
      await window.architect.writeContextIndex(json);
    },
  };
  chatPanel.onSendMessage = createSendMessageHandler(chatMessageDeps);

  // Wire card action handling
  chatPanel.onCardAction = createCardActionHandler({
    chatPanel,
    docPreview,
    getDefinition: () => State.getDefinition(),
    hasPolicy: () => State.getPolicy() !== null,
  });

  // Wire test panel
  const testWorkflowDeps: TestWorkflowDeps = {
    ...stateAccessor,
    policyService, chatSessionMgr, chatPanel, docPreview, testPanel,
    loadBuildAssets,
  };
  wireTestPanelHandlers(testWorkflowDeps);

  // Wire document highlight click → chat
  docPreview.onHighlightClick = (entry) => {
    if (entry.ruleId) {
      chatPanel.onSendMessage?.(`Explain rule ${entry.ruleId}`);
    } else if (entry.variableName) {
      chatPanel.onSendMessage?.(`Explain the variable "${entry.variableName}" and how it's used in the policy.`);
    }
  };

  // Wire entity link click → filter document preview
  chatPanel.onEntityClick = (entityType, entityId) => {
    const rawDef = State.getDefinition();
    const def = rawDef ? toAppDefinition(rawDef) : null;
    docPreview.filterByEntity(entityType, entityId, def ?? undefined);
  };

  docPreview.onEntityFilterBack = () => {};

  docPreview.onRegenerateFidelityReport = () => {
    if (!State.getPolicy() || !State.getDefinition()) return;
    const assets = buildAssetsStore.get();
    if (assets) {
      assets.fidelityReport = null;
      assets.rawFidelityReport = null;
      buildAssetsStore.set(assets);
    }
    docPreview.setRegenerateButtonVisible(false);
    generateFidelityReport().catch((err) => {
      console.warn("[onRegenerateFidelityReport] Failed:", (err as Error).message);
    });
  };

  // Central hook: test execution triggers test panel refresh
  policyService.onTestsExecuted(() => {
    if (State.getPolicy()) refreshTestsAfterPolicyChange();
  });

  window.architect.onAcpUpdate((update: unknown) => {
    const u = update as import("./types").AcpSessionUpdate;
    if (u.sessionUpdate === "tool_call_update" && u.status === "completed" && State.getPolicy()) {
      if (/execute_tests/i.test(u.title)) {
        refreshTestsAfterPolicyChange();
      }
    }
  });

  console.log("[initializeWorkspaceUI] Legacy UI components initialized");
}

function refreshTestsAfterPolicyChange(): void {
  if (!uiInitialized) return;
  refreshTestsWorkflow({
    ...stateAccessor,
    policyService, chatSessionMgr, chatPanel, docPreview, testPanel,
    loadBuildAssets,
  });
}

// Add platform class for OS-specific styling (e.g. macOS traffic light inset)
if (navigator.userAgent.includes("Macintosh")) {
  document.body.classList.add("platform-macos");
}

const reactRootEl = document.getElementById("react-root");
if (reactRootEl) {
  applyMode(Mode.Dark);

  reactRootEl.style.display = "flex";
  reactRootEl.style.flexDirection = "column";
  reactRootEl.style.height = "100%";
  const appEl = document.getElementById("app");
  if (appEl) appEl.style.display = "none";

  const reactRoot = createRoot(reactRootEl);
  reactRoot.render(
    React.createElement(App, {
      services: { policyService, buildOrchestrator, chatSessionMgr },
      onNewPolicy: () => handleNewPolicy(),
      onOpenPolicy: () => handleOpenPolicy(),
      onScreenChange: () => {},
      onWorkspaceReady: () => onWorkspaceReady(),
      onTestPanelHandle: (handle: TestPanelHandle) => { testPanel = handle; },
      onDocPreviewHandle: (handle: DocumentPreviewHandle) => { docPreview = handle; },
      onChatPanelHandle: (handle: ChatPanelHandle) => {
        chatPanel = handle;
        // Create the policy-bound UI from the router now that it's available
        policyBoundUI = handle.getRouter().createBoundUI("policy");
      },
      fetchPolicies: () => policyService.listPolicies(),
      onPolicySelected: (arn: string, name: string) => handlePolicySelected(arn, name),
      onCreatePolicy: (name: string, filePath: string, maxLevel: number) => handleCreatePolicy(name, filePath, maxLevel),
      openFileDialog: () => window.architect.openMarkdownDialog(),
    })
  );
}
