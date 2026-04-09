/**
 * Integration tests for the loadPolicy flow.
 *
 * These tests exercise the full open-policy path through renderer → services → preload bridge
 * with controllable mocks at the IPC boundary (window.architect). Unlike the unit tests that
 * mock at the service layer, these tests let the real ChatService, PolicyService, and ChatPanel
 * run, only stubbing the external boundaries:
 *
 *   - window.architect.*  (IPC bridge to main process)
 *   - AWS SDK client send  (network calls)
 *
 * This lets us catch integration issues like the "stuck at Connecting to agent" bug where
 * ChatService.connect() hangs because acpStart or acpCreateSession never resolves.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";


// ─── AWS SDK mock ───
// Must be hoisted before any module imports the SDK.
const mockSend = vi.fn();
vi.mock("@aws-sdk/client-bedrock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-bedrock")>();
  return {
    ...actual,
    BedrockClient: vi.fn().mockImplementation(function () { return { send: mockSend }; }),
  };
});

// ─── DOM scaffolding ───

function setupDOM(): void {
  document.body.innerHTML = `
    <div class="screen active" id="landing-screen"></div>
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

// ─── IPC bridge mock ───

interface ArchitectMock {
  openFileDialog: Mock;
  readFileBase64: Mock;
  readFileText: Mock;
  saveMetadata: Mock;
  loadMetadata: Mock;
  loadLocalState: Mock;
  saveLocalState: Mock;
  saveFidelityReport: Mock;
  loadFidelityReport: Mock;
  saveScenarios: Mock;
  loadScenarios: Mock;
  writeApprovalCode: Mock;
  openMarkdownDialog: Mock;
  getRegion: Mock;
  getCredentials: Mock;
  getMcpServerPath: Mock;
  getApprovalCodeFilePath: Mock;
  getContextIndexFilePath: Mock;
  writeContextIndex: Mock;
  acpStart: Mock;
  acpCreateSession: Mock;
  acpSendPrompt: Mock;
  acpCancel: Mock;
  acpStop: Mock;
  onAcpUpdate: Mock;
}

function createArchitectMock(): ArchitectMock {
  return {
    openFileDialog: vi.fn().mockResolvedValue(null),
    readFileBase64: vi.fn().mockResolvedValue(""),
    readFileText: vi.fn().mockResolvedValue(""),
    saveMetadata: vi.fn().mockResolvedValue(undefined),
    loadMetadata: vi.fn().mockResolvedValue(null),
    loadLocalState: vi.fn().mockResolvedValue(null),
    saveLocalState: vi.fn().mockResolvedValue(undefined),
    saveFidelityReport: vi.fn().mockResolvedValue(undefined),
    loadFidelityReport: vi.fn().mockResolvedValue(null),
    saveScenarios: vi.fn().mockResolvedValue(undefined),
    loadScenarios: vi.fn().mockResolvedValue(null),
    writeApprovalCode: vi.fn().mockResolvedValue(undefined),
    openMarkdownDialog: vi.fn().mockResolvedValue(null),
    getCredentials: vi.fn().mockResolvedValue({
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
      sessionToken: "TOKEN",
    }),
    getRegion: vi.fn().mockReturnValue("us-west-2"),
    getMcpServerPath: vi.fn().mockResolvedValue("/mock/mcp-server.js"),
    getNodeCommand: vi.fn().mockResolvedValue("node"),
    getApprovalCodeFilePath: vi.fn().mockResolvedValue("/mock/approval-codes.json"),
    getContextIndexFilePath: vi.fn().mockResolvedValue("/mock/context-index.json"),
    writeContextIndex: vi.fn().mockResolvedValue(undefined),
    acpStart: vi.fn().mockResolvedValue(undefined),
    acpCreateSession: vi.fn().mockResolvedValue("session-123"),
    acpSendPrompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
    acpCancel: vi.fn(),
    acpStop: vi.fn(),
    onAcpUpdate: vi.fn(),
  };
}

// ─── Helpers ───

const TEST_ARN = "arn:aws:bedrock:us-west-2:123456789012:automated-reasoning-policy/test-id";
const POLICY_DEF = { version: "1.0", types: [], rules: [], variables: [] };

/** Collect all status messages rendered into #chat-messages. */
function getStatusMessages(): string[] {
  return Array.from(document.querySelectorAll("#chat-messages .chat-msg"))
    .map((el) => el.textContent ?? "")
    .filter(Boolean);
}

/** Return the text of the last status message. */
function lastStatus(): string {
  const msgs = getStatusMessages();
  return msgs[msgs.length - 1] ?? "";
}

/**
 * Configure mockSend to dispatch based on SDK command type.
 * Accepts overrides per command for custom behavior.
 */
function configureSdkMock(overrides: Partial<Record<string, () => Promise<unknown>>> = {}): void {
  mockSend.mockImplementation((command: unknown) => {
    const name = (command as any)?.constructor?.name as string | undefined;
    if (name && overrides[name]) return overrides[name]!();

    // Default happy-path responses
    switch (name) {
      case "ExportAutomatedReasoningPolicyVersionCommand":
        return Promise.resolve({ policyDefinition: POLICY_DEF });
      case "ListAutomatedReasoningPolicyBuildWorkflowsCommand":
        return Promise.resolve({ automatedReasoningPolicyBuildWorkflowSummaries: [] });
      case "GetAutomatedReasoningPolicyBuildWorkflowResultAssetsCommand":
        return Promise.resolve({ buildWorkflowAssets: undefined });
      default:
        return Promise.resolve({});
    }
  });
}

// ─── Test suites ───

describe("loadPolicy integration — happy path", () => {
  let loadPolicy: (arn: string, name: string) => Promise<void>;
  let architectMock: ArchitectMock;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    setupDOM();
    architectMock = createArchitectMock();
    (window as any).architect = architectMock;
    configureSdkMock();

    const renderer = await import("./renderer");
    loadPolicy = renderer.loadPolicy;
  });

  afterEach(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
  });

  it("completes the full flow and shows 'Loaded policy'", async () => {
    await loadPolicy(TEST_ARN, "Happy Policy");

    expect(lastStatus()).toContain("Loaded policy: Happy Policy");
    // Verify the IPC bridge was called in the right order
    expect(architectMock.acpStart).toHaveBeenCalled();
    expect(architectMock.acpCreateSession).toHaveBeenCalled();
    expect(architectMock.loadMetadata).toHaveBeenCalledWith(TEST_ARN);
  });

  it("loads document preview when metadata has documentPath", async () => {
    architectMock.loadMetadata.mockResolvedValue(JSON.stringify({
      policyArn: TEST_ARN,
      name: "Doc Policy",
      documentPath: "/tmp/policy.txt",
    }));
    architectMock.readFileText.mockResolvedValue("Section 1: All requests must be approved.");

    await loadPolicy(TEST_ARN, "Doc Policy");

    expect(architectMock.readFileText).toHaveBeenCalledWith("/tmp/policy.txt");
    expect(lastStatus()).toContain("Loaded policy: Doc Policy");
  });

  it("loads build assets in background when a completed build exists", async () => {
    configureSdkMock({
      ListAutomatedReasoningPolicyBuildWorkflowsCommand: () => Promise.resolve({
        automatedReasoningPolicyBuildWorkflowSummaries: [{
          buildWorkflowId: "build-abc",
          buildWorkflowType: "IMPORT_POLICY",
          status: "COMPLETED",
          createdAt: new Date(),
          updatedAt: new Date(),
        }],
      }),
      GetAutomatedReasoningPolicyBuildWorkflowResultAssetsCommand: () => Promise.resolve({
        buildWorkflowAssets: { policyDefinition: POLICY_DEF },
      }),
    });

    await loadPolicy(TEST_ARN, "Build Policy");
    expect(lastStatus()).toContain("Loaded policy: Build Policy");

    // Let background build asset loading settle
    await vi.advanceTimersByTimeAsync(50_000);

    // Verify build assets were fetched (5 asset types in parallel: POLICY_DEFINITION, BUILD_LOG, QUALITY_REPORT, FIDELITY_REPORT, POLICY_SCENARIOS)
    const assetCalls = mockSend.mock.calls.filter(
      (args: unknown[]) => (args[0] as any)?.constructor?.name === "GetAutomatedReasoningPolicyBuildWorkflowResultAssetsCommand"
    );
    expect(assetCalls.length).toBe(5);
  });
});

describe("loadPolicy integration — ACP connection failures", () => {
  let loadPolicy: (arn: string, name: string) => Promise<void>;
  let architectMock: ArchitectMock;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    setupDOM();
    architectMock = createArchitectMock();
    (window as any).architect = architectMock;
    configureSdkMock();

    const renderer = await import("./renderer");
    loadPolicy = renderer.loadPolicy;
  });

  afterEach(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
  });

  it("recovers when acpStart hangs — times out and continues loading", async () => {
    // Simulate acpStart never resolving (Kiro CLI not installed / hangs)
    architectMock.acpStart.mockReturnValue(new Promise(() => {}));

    const loadPromise = loadPolicy(TEST_ARN, "Hang Policy");

    // Advance past the 15s connect timeout
    await vi.advanceTimersByTimeAsync(16_000);
    await loadPromise;

    // Should still load the policy despite chat connection failure
    const msgs = getStatusMessages();
    expect(msgs.some((m) => m.includes("Loaded policy: Hang Policy"))).toBe(true);
    expect(msgs.some((m) => m.includes("Agent connection failed"))).toBe(true);
  });

  it("recovers when acpCreateSession hangs — times out and continues", async () => {
    architectMock.acpCreateSession.mockReturnValue(new Promise(() => {}));

    const loadPromise = loadPolicy(TEST_ARN, "Session Hang");

    await vi.advanceTimersByTimeAsync(16_000);
    await loadPromise;

    const msgs = getStatusMessages();
    expect(msgs.some((m) => m.includes("Loaded policy: Session Hang"))).toBe(true);
    expect(msgs.some((m) => m.includes("Agent connection failed"))).toBe(true);
  });

  it("recovers when acpStart rejects — shows warning and continues", async () => {
    architectMock.acpStart.mockRejectedValue(new Error("spawn ENOENT: kiro-cli not found"));

    await loadPolicy(TEST_ARN, "No CLI Policy");

    const msgs = getStatusMessages();
    expect(msgs.some((m) => m.includes("Loaded policy: No CLI Policy"))).toBe(true);
    expect(msgs.some((m) => m.includes("Agent connection failed"))).toBe(true);
  });

  it("recovers when acpCreateSession rejects", async () => {
    architectMock.acpCreateSession.mockRejectedValue(new Error("ACP error -32600: invalid session"));

    await loadPolicy(TEST_ARN, "Bad Session");

    const msgs = getStatusMessages();
    expect(msgs.some((m) => m.includes("Loaded policy: Bad Session"))).toBe(true);
  });
});

describe("loadPolicy integration — SDK failures", () => {
  let loadPolicy: (arn: string, name: string) => Promise<void>;
  let architectMock: ArchitectMock;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    setupDOM();
    architectMock = createArchitectMock();
    (window as any).architect = architectMock;

    const renderer = await import("./renderer");
    loadPolicy = renderer.loadPolicy;
  });

  afterEach(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
  });

  it("shows error when exportPolicyDefinition fails", async () => {
    configureSdkMock({
      ExportAutomatedReasoningPolicyVersionCommand: () =>
        Promise.reject(new Error("AccessDeniedException")),
    });

    await loadPolicy(TEST_ARN, "Denied Policy");

    expect(lastStatus()).toContain("Failed to load policy definition");
    expect(lastStatus()).toContain("AccessDeniedException");
    // Should NOT have tried to load metadata
    expect(architectMock.loadMetadata).not.toHaveBeenCalled();
  });

  it("shows error when exportPolicyDefinition hangs past timeout", async () => {
    configureSdkMock({
      ExportAutomatedReasoningPolicyVersionCommand: () => new Promise(() => {}),
    });

    const loadPromise = loadPolicy(TEST_ARN, "Timeout Policy");
    // Advance past connect timeout (15s) + export timeout (30s)
    await vi.advanceTimersByTimeAsync(50_000);
    await loadPromise;

    expect(lastStatus()).toContain("Failed to load policy definition");
    expect(lastStatus()).toContain("timed out");
  });

  it("still loads when listBuilds fails in background", async () => {
    configureSdkMock({
      ListAutomatedReasoningPolicyBuildWorkflowsCommand: () =>
        Promise.reject(new Error("ServiceUnavailable")),
    });

    await loadPolicy(TEST_ARN, "Build Fail Policy");
    expect(lastStatus()).toContain("Loaded policy: Build Fail Policy");

    await vi.advanceTimersByTimeAsync(50_000);
    const msgs = getStatusMessages();
    expect(msgs.some((m) => m.includes("Could not load build history"))).toBe(true);
  });
});

describe("loadPolicy integration — metadata edge cases", () => {
  let loadPolicy: (arn: string, name: string) => Promise<void>;
  let architectMock: ArchitectMock;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    setupDOM();
    architectMock = createArchitectMock();
    (window as any).architect = architectMock;
    configureSdkMock();

    const renderer = await import("./renderer");
    loadPolicy = renderer.loadPolicy;
  });

  afterEach(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
  });

  it("handles corrupt metadata JSON gracefully", async () => {
    architectMock.loadMetadata.mockResolvedValue("{{not json");

    await loadPolicy(TEST_ARN, "Corrupt Meta");

    const msgs = getStatusMessages();
    expect(msgs.some((m) => m.includes("Loaded policy: Corrupt Meta"))).toBe(true);
    expect(msgs.some((m) => m.includes("Could not read saved metadata"))).toBe(true);
  });

  it("handles missing document file gracefully", async () => {
    architectMock.loadMetadata.mockResolvedValue(JSON.stringify({
      policyArn: TEST_ARN,
      name: "Missing Doc",
      documentPath: "/nonexistent/file.pdf",
    }));
    architectMock.readFileText.mockRejectedValue(new Error("ENOENT"));

    await loadPolicy(TEST_ARN, "Missing Doc");

    const msgs = getStatusMessages();
    expect(msgs.some((m) => m.includes("Loaded policy: Missing Doc"))).toBe(true);
    expect(msgs.some((m) => m.includes("Source document not found"))).toBe(true);
  });
});
