/**
 * Unit tests for loadPolicy — error paths, build asset loading, and non-blocking behavior.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Shared mock instances that persist across module reloads
const mockPolicyService = {
  listPolicies: vi.fn(),
  exportPolicyDefinition: vi.fn(),
  listBuilds: vi.fn(),
  listTestCases: vi.fn(),
  listTestResults: vi.fn().mockResolvedValue([]),
  loadTestsWithResults: vi.fn().mockResolvedValue([]),
  createPolicy: vi.fn(),
  startBuild: vi.fn(),
  pollBuild: vi.fn(),
  getBuildAssets: vi.fn(),
  updatePolicy: vi.fn(),
  runTests: vi.fn(),
  manageBuildSlot: vi.fn(),
  findLatestPolicyBuild: vi.fn((builds: any[]) => builds?.find((b: any) => b.status === "COMPLETED" && b.buildWorkflowType !== "GENERATE_FIDELITY_REPORT")),
  pollTestCompletion: vi.fn().mockResolvedValue([]),
  startFidelityReportBuild: vi.fn(),
  createTestCase: vi.fn(),
  deleteBuild: vi.fn(),
  onTestsExecuted: vi.fn().mockReturnValue(() => {}),
  emitTestsExecuted: vi.fn(),
};

const mockChatPanel = {
  appendStatus: vi.fn((text: string) => {
    const el = document.createElement("div");
    el.className = "chat-msg assistant status-bubble";
    const currentStep = document.createElement("div");
    currentStep.className = "status-current-step";
    currentStep.textContent = text;
    el.appendChild(currentStep);
    return el;
  }),
  updateStatus: vi.fn((statusEl: HTMLElement, text: string) => {
    const currentStep = statusEl.querySelector(".status-current-step");
    if (currentStep) currentStep.textContent = text;
    else statusEl.textContent = text;
  }),
  appendMessage: vi.fn(),
  startStreaming: vi.fn(() => {
    const el = document.createElement("div");
    el.className = "chat-msg assistant streaming markdown-body";
    return el;
  }),
  pushStreamChunk: vi.fn(),
  endStreaming: vi.fn(),
  abortStreaming: vi.fn(),
  clearMessages: vi.fn(),
  setContext: vi.fn(),
  prefillInput: vi.fn(),
  updateKnownEntities: vi.fn(),
  linkifyEntities: vi.fn(),
  onSendMessage: null as any,
  onCardAction: null as any,
  onBackToPolicy: null as any,
  onEntityClick: null as any,
};

const mockDocPreview = {
  loadDocument: vi.fn(),
  setHighlightsFromSummary: vi.fn(),
  setHighlightsFromFidelityReport: vi.fn(),
  toggle: vi.fn(),
  showOpenPrompt: vi.fn(),
  clearFilter: vi.fn(),
  filterByTestFindings: vi.fn(),
  emphasize: vi.fn(),
  setLoading: vi.fn(),
  setRegenerateButtonVisible: vi.fn(),
  getRawText: vi.fn().mockReturnValue(""),
  hasDocument: false,
  onHighlightClick: null as any,
  onEntityFilterBack: null as any,
  onRegenerateFidelityReport: null as any,
};

vi.mock("./services/policy-service", () => ({
  PolicyService: vi.fn().mockImplementation(function () { return mockPolicyService; }),
  ACTIVE_BUILD_STATUSES: new Set(["SCHEDULED", "CANCEL_REQUESTED", "PREPROCESSING", "BUILDING", "TESTING"]),
  TERMINAL_BUILD_STATUSES: new Set(["COMPLETED", "FAILED", "CANCELLED"]),
  ACTIVE_TEST_STATUSES: new Set(["IN_PROGRESS", "SCHEDULED", "NOT_STARTED"]),
}));

vi.mock("./services/chat-service", () => ({
  ChatService: vi.fn().mockImplementation(function () {
    return {
      summarizeDocument: vi.fn(),
      sendPolicyMessage: vi.fn().mockResolvedValue({ id: "mock", role: "assistant", content: "", timestamp: 0 }),
      onUpdate: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      cancel: vi.fn(),
    };
  }),
}));

// chat-panel.ts is deleted — ChatPanel is now a React component.
// The test harness uses the stub created in initializeWorkspaceUI.

vi.mock("./components/document-preview", () => ({
  DocumentPreview: vi.fn().mockImplementation(function () { return mockDocPreview; }),
}));

vi.mock("./components/policy-picker", () => ({
  PolicyPicker: vi.fn().mockImplementation(function () {
    return {
      showLoading: vi.fn(),
      showPolicies: vi.fn(),
      showError: vi.fn(),
      close: vi.fn(),
      onSelect: null,
      onCancel: null,
    };
  }),
}));

function setupDOM() {
  document.body.innerHTML = `
    <div class="screen" id="landing-screen"></div>
    <div class="screen" id="workspace-screen"></div>
    <div id="policy-picker-container"></div>
    <div id="document-content"></div>
    <div id="chat-messages"></div>
    <textarea id="chat-input"></textarea>
    <button id="btn-send"></button>
    <button id="btn-new-policy"></button>
    <button id="btn-open-policy"></button>
    <button id="btn-collapse-doc"></button>
    <button id="btn-collapse-tests"></button>
    <button id="btn-refresh-tests"></button>
    <button id="btn-back-to-policy" style="display:none;"></button>
    <button id="btn-copy-chat"></button>
    <button id="btn-download-chat"></button>
    <span id="chat-context-label">Policy Chat</span>
    <div id="document-panel"></div>
    <div id="panel-divider-left"></div>
    <div id="test-panel"><div id="test-list"></div></div>
    <div id="panel-divider-right"></div>
  `;
}

function setupArchitectMock() {
  (window as any).architect = {
    openFileDialog: vi.fn(),
    readFileBase64: vi.fn(),
    readFileText: vi.fn(),
    saveMetadata: vi.fn(),
    loadMetadata: vi.fn(),
    loadLocalState: vi.fn().mockResolvedValue(null),
    saveLocalState: vi.fn(),
    saveFidelityReport: vi.fn(),
    loadFidelityReport: vi.fn().mockResolvedValue(null),
    saveScenarios: vi.fn(),
    loadScenarios: vi.fn().mockResolvedValue(null),
    writeApprovalCode: vi.fn(),
    openMarkdownDialog: vi.fn(),
    getCredentials: vi.fn().mockResolvedValue({ accessKeyId: "test", secretAccessKey: "test" }),
    getRegion: vi.fn().mockReturnValue("us-west-2"),
    getMcpServerPath: vi.fn().mockResolvedValue("/mock/mcp-server.js"),
    getNodeCommand: vi.fn().mockResolvedValue("node"),
    getApprovalCodeFilePath: vi.fn().mockResolvedValue("/mock/approval-codes.json"),
    getContextIndexFilePath: vi.fn().mockResolvedValue("/mock/context-index.json"),
    writeContextIndex: vi.fn().mockResolvedValue(undefined),
    acpStart: vi.fn(),
    acpCreateSession: vi.fn(),
    acpSendPrompt: vi.fn(),
    acpCancel: vi.fn(),
    acpStop: vi.fn(),
    onAcpUpdate: vi.fn(),
  };
}

/** Flush microtask queue so fire-and-forget promises settle. */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("loadPolicy error paths", () => {
  let loadPolicy: (policyArn: string, name: string) => Promise<void>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    setupDOM();
    setupArchitectMock();

    mockPolicyService.listTestCases.mockResolvedValue([]);

    mockChatPanel.appendStatus.mockImplementation((text: string) => {
      const el = document.createElement("div");
      el.textContent = text;
      return el;
    });

    const renderer = await import("./renderer");
    loadPolicy = renderer.loadPolicy;
  });

  afterEach(async () => {
    // Settle any fire-and-forget background promises
    await vi.advanceTimersByTimeAsync(50_000);
    vi.useRealTimers();
  });

  it("export failure shows error in chat and does not set currentDefinition", async () => {
    mockPolicyService.exportPolicyDefinition.mockRejectedValue(
      new Error("Access denied")
    );

    await loadPolicy("arn:aws:test:policy/123", "Test Policy");

    const chatMessages = document.getElementById("chat-messages")!;
    expect(chatMessages.textContent).toContain("Failed to load policy definition");
    expect(chatMessages.textContent).toContain("Access denied");

    expect((window as any).architect.loadMetadata).not.toHaveBeenCalled();
    expect(mockPolicyService.listBuilds).not.toHaveBeenCalled();
  });

  it("missing metadata proceeds with minimal object", async () => {
    mockPolicyService.exportPolicyDefinition.mockResolvedValue({
      version: "1.0", rules: [], variables: [], types: [],
    });
    (window as any).architect.loadMetadata.mockResolvedValue(null);
    mockPolicyService.listBuilds.mockResolvedValue([]);

    await loadPolicy("arn:aws:test:policy/456", "My Policy");

    const chatMessages = document.getElementById("chat-messages")!;
    expect(chatMessages.textContent).toContain("Loaded policy: My Policy");
  });

  it("corrupt JSON metadata shows warning and proceeds with minimal object", async () => {
    mockPolicyService.exportPolicyDefinition.mockResolvedValue({
      version: "1.0", rules: [], variables: [], types: [],
    });
    (window as any).architect.loadMetadata.mockResolvedValue("{not valid json!!!");
    mockPolicyService.listBuilds.mockResolvedValue([]);

    await loadPolicy("arn:aws:test:policy/789", "Corrupt Policy");

    const chatMessages = document.getElementById("chat-messages")!;
    expect(chatMessages.textContent).toContain("Could not read saved metadata");
    expect(chatMessages.textContent).toContain("Loaded policy: Corrupt Policy");
  });

  it("missing document file shows notice and skips preview", async () => {
    mockPolicyService.exportPolicyDefinition.mockResolvedValue({
      version: "1.0", rules: [], variables: [], types: [],
    });
    (window as any).architect.loadMetadata.mockResolvedValue(
      JSON.stringify({
        policyArn: "arn:aws:test:policy/doc",
        name: "Doc Policy",
        documentPath: "/path/to/missing.pdf",
      })
    );
    (window as any).architect.readFileText.mockRejectedValue(
      new Error("ENOENT: no such file")
    );
    mockPolicyService.listBuilds.mockResolvedValue([]);

    await loadPolicy("arn:aws:test:policy/doc", "Doc Policy");

    const chatMessages = document.getElementById("chat-messages")!;
    expect(chatMessages.textContent).toContain("Source document not found");
    expect(mockDocPreview.loadDocument).not.toHaveBeenCalled();
  });

  it("build list failure shows warning and still reports loaded", async () => {
    mockPolicyService.exportPolicyDefinition.mockResolvedValue({
      version: "1.0", rules: [], variables: [], types: [],
    });
    (window as any).architect.loadMetadata.mockResolvedValue(null);
    mockPolicyService.listBuilds.mockRejectedValue(
      new Error("Service unavailable")
    );

    await loadPolicy("arn:aws:test:policy/build", "Build Policy");

    const chatMessages = document.getElementById("chat-messages")!;
    expect(chatMessages.textContent).toContain("Loaded policy: Build Policy");

    // Advance timers so the background promise settles and shows the warning
    await vi.advanceTimersByTimeAsync(50_000);

    expect(chatMessages.textContent).toContain("Could not load build history");
  });
});

describe("loadPolicy build asset loading", () => {
  let loadPolicy: (policyArn: string, name: string) => Promise<void>;
  let getStoreAssets: () => any;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    setupDOM();
    setupArchitectMock();

    mockPolicyService.listTestCases.mockResolvedValue([]);

    mockChatPanel.appendStatus.mockImplementation((text: string) => {
      const el = document.createElement("div");
      el.textContent = text;
      return el;
    });

    // Import both renderer and the store from the same module graph
    const [renderer, storeModule] = await Promise.all([
      import("./renderer"),
      import("./services/build-assets-store"),
    ]);
    loadPolicy = renderer.loadPolicy;
    getStoreAssets = () => storeModule.buildAssetsStore.get();
    storeModule.buildAssetsStore.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Advance fake timers enough for the background promise chain to settle. */
  async function settleBackground(): Promise<void> {
    // Advance past withTimeout timers and flush microtasks
    await vi.advanceTimersByTimeAsync(50_000);
  }

  it("sets loaded status before build assets finish loading", async () => {
    mockPolicyService.exportPolicyDefinition.mockResolvedValue({
      version: "1.0", rules: [], variables: [], types: [],
    });
    (window as any).architect.loadMetadata.mockResolvedValue(null);

    // listBuilds resolves immediately, but getBuildAssets is slow
    let resolveAssets!: (v: undefined) => void;
    const slowAssets = new Promise<undefined>((r) => { resolveAssets = r; });
    mockPolicyService.listBuilds.mockResolvedValue([
      { buildWorkflowId: "build-1", status: "COMPLETED" },
    ]);
    mockPolicyService.getBuildAssets.mockReturnValue(slowAssets);

    await loadPolicy("arn:aws:test:policy/slow", "Slow Policy");

    // Status should say "Loaded" even though assets haven't resolved yet
    const chatMessages = document.getElementById("chat-messages")!;
    expect(chatMessages.textContent).toContain("Loaded policy: Slow Policy");

    // Store should be empty since assets haven't resolved
    expect(getStoreAssets()).toBeNull();

    // Now resolve the assets and let the background settle
    resolveAssets(undefined);
    await settleBackground();

    // Now the store should be populated
    expect(getStoreAssets()).not.toBeNull();
  });

  it("populates store when a completed build exists", async () => {
    mockPolicyService.exportPolicyDefinition.mockResolvedValue({
      version: "1.0", rules: [], variables: [], types: [],
    });
    (window as any).architect.loadMetadata.mockResolvedValue(null);
    mockPolicyService.listBuilds.mockResolvedValue([
      { buildWorkflowId: "build-42", status: "COMPLETED" },
    ]);
    mockPolicyService.getBuildAssets.mockResolvedValue(undefined);

    await loadPolicy("arn:aws:test:policy/assets", "Assets Policy");
    await settleBackground();

    const assets = getStoreAssets();
    expect(assets).not.toBeNull();
    expect(assets!.buildWorkflowId).toBe("build-42");
  });

  it("stores raw assets when getBuildAssets returns data", async () => {
    mockPolicyService.exportPolicyDefinition.mockResolvedValue({
      version: "1.0", rules: [], variables: [], types: [],
    });
    (window as any).architect.loadMetadata.mockResolvedValue(null);
    mockPolicyService.listBuilds.mockResolvedValue([
      { buildWorkflowId: "build-99", status: "COMPLETED" },
    ]);

    const fakeDef = {
      policyDefinition: { version: "1.0", types: [], rules: [{ ruleId: "R1" }], variables: [] },
    };
    const fakeLog = { buildLog: { entries: [{ annotation: {}, buildSteps: [], status: "APPLIED" }] } };
    const fakeQuality = {
      qualityReport: { unusedVariables: ["x"] },
    };

    mockPolicyService.getBuildAssets.mockImplementation(
      (_arn: string, _id: string, assetType: string) => {
        if (assetType === "POLICY_DEFINITION") return Promise.resolve(fakeDef);
        if (assetType === "BUILD_LOG") return Promise.resolve(fakeLog);
        if (assetType === "QUALITY_REPORT") return Promise.resolve(fakeQuality);
        return Promise.resolve(undefined);
      }
    );

    await loadPolicy("arn:aws:test:policy/full", "Full Policy");
    await settleBackground();

    const assets = getStoreAssets();
    expect(assets).not.toBeNull();
    expect(assets!.rawPolicyDefinition).toEqual(fakeDef);
    expect(assets!.rawBuildLog).toEqual(fakeLog);
    expect(assets!.rawQualityReport).toEqual(fakeQuality);
    expect(assets!.policyDefinition?.rules).toHaveLength(1);
    expect(assets!.buildLog).toHaveLength(1);
    expect(assets!.qualityReport).toHaveLength(1);
  });

  it("handles partial asset failures gracefully", async () => {
    mockPolicyService.exportPolicyDefinition.mockResolvedValue({
      version: "1.0", rules: [], variables: [], types: [],
    });
    (window as any).architect.loadMetadata.mockResolvedValue(null);
    mockPolicyService.listBuilds.mockResolvedValue([
      { buildWorkflowId: "build-partial", status: "COMPLETED" },
    ]);

    mockPolicyService.getBuildAssets.mockImplementation(
      (_arn: string, _id: string, assetType: string) => {
        if (assetType === "POLICY_DEFINITION")
          return Promise.resolve({
            policyDefinition: { version: "1.0", types: [], rules: [], variables: [] },
          });
        if (assetType === "BUILD_LOG")
          return Promise.reject(new Error("Not found"));
        if (assetType === "QUALITY_REPORT")
          return Promise.resolve({
            qualityReport: { disjointRuleSets: [["A", "B"]] },
          });
        return Promise.resolve(undefined);
      }
    );

    await loadPolicy("arn:aws:test:policy/partial", "Partial Policy");
    await settleBackground();

    const assets = getStoreAssets();
    expect(assets).not.toBeNull();
    expect(assets!.policyDefinition).not.toBeNull();
    expect(assets!.rawBuildLog).toBeNull();
    expect(assets!.buildLog).toBeNull();
    expect(assets!.qualityReport).toHaveLength(1);
  });

  it("does not populate store when no completed build exists", async () => {
    mockPolicyService.exportPolicyDefinition.mockResolvedValue({
      version: "1.0", rules: [], variables: [], types: [],
    });
    (window as any).architect.loadMetadata.mockResolvedValue(null);
    mockPolicyService.listBuilds.mockResolvedValue([
      { buildWorkflowId: "build-wip", status: "IN_PROGRESS" },
    ]);

    await loadPolicy("arn:aws:test:policy/nobuilds", "No Builds");
    await settleBackground();

    expect(getStoreAssets()).toBeNull();
    expect(mockPolicyService.getBuildAssets).not.toHaveBeenCalled();
  });
});

describe("BuildAssetsStore", () => {
  let store: any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("./services/build-assets-store");
    store = mod.buildAssetsStore;
    store.clear();
  });

  it("starts with null", () => {
    expect(store.get()).toBeNull();
  });

  it("set() stores and get() retrieves assets", () => {
    const assets = {
      buildWorkflowId: "b1",
      policyDefinition: null,
      rawPolicyDefinition: null,
      buildLog: null,
      rawBuildLog: null,
      qualityReport: null,
      rawQualityReport: null,
    };
    store.set(assets);
    expect(store.get()).toBe(assets);
  });

  it("clear() resets to null", () => {
    store.set({
      buildWorkflowId: "b2",
      policyDefinition: null,
      rawPolicyDefinition: null,
      buildLog: null,
      rawBuildLog: null,
      qualityReport: null,
      rawQualityReport: null,
    });
    store.clear();
    expect(store.get()).toBeNull();
  });

  it("subscribe() notifies on set()", () => {
    const listener = vi.fn();
    store.subscribe(listener);

    const assets = {
      buildWorkflowId: "b3",
      policyDefinition: null,
      rawPolicyDefinition: null,
      buildLog: null,
      rawBuildLog: null,
      qualityReport: null,
      rawQualityReport: null,
    };
    store.set(assets);
    expect(listener).toHaveBeenCalledWith(assets);
  });

  it("unsubscribe stops notifications", () => {
    const listener = vi.fn();
    const unsub = store.subscribe(listener);
    unsub();

    store.set({
      buildWorkflowId: "b4",
      policyDefinition: null,
      rawPolicyDefinition: null,
      buildLog: null,
      rawBuildLog: null,
      qualityReport: null,
      rawQualityReport: null,
    });
    expect(listener).not.toHaveBeenCalled();
  });
});
