/**
 * Integration tests for BuildOrchestrator with mocked PolicyService and UI/State callbacks.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { BuildOrchestrator } from "./build-orchestrator";
import type { BuildOrchestratorUI, BuildOrchestratorState } from "./build-orchestrator";
import { buildAssetsStore } from "./build-assets-store";
import type { PolicyService } from "./policy-service";

const ARN = "arn:aws:bedrock:us-west-2:123456789:policy/test-policy";
const BUILD_ID = "bw-build-789";

function createMockPolicyService(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    getBuildAssets: vi.fn().mockResolvedValue(null),
    listBuilds: vi.fn().mockResolvedValue([]),
    findLatestPolicyBuild: vi.fn().mockReturnValue(undefined),
    pollBuild: vi.fn().mockResolvedValue({ buildWorkflowId: BUILD_ID, status: "COMPLETED" }),
    loadTestsWithResults: vi.fn().mockResolvedValue([]),
    onTestsExecuted: vi.fn().mockReturnValue(() => {}),
  };
}

function createMockUI(): BuildOrchestratorUI {
  return {
    docSetLoading: vi.fn(),
    docSetHighlights: vi.fn(),
    docSetRegenerateVisible: vi.fn(),
    docSetStaleBanner: vi.fn(),
    testSetLoading: vi.fn(),
    testLoadTests: vi.fn(),
    chatAppendStatus: vi.fn(() => document.createElement("div")),
  };
}

function createMockState(): BuildOrchestratorState {
  return {
    getPolicy: vi.fn().mockReturnValue({ policyArn: ARN, name: "test" }),
    getLocalState: vi.fn().mockReturnValue(null),
    getDefinition: vi.fn().mockReturnValue(null),
    getBuildWorkflowId: vi.fn().mockReturnValue(null),
    setBuildWorkflowId: vi.fn(),
    setTestCases: vi.fn(),
    setTestsWithResults: vi.fn(),
    getSourceDocumentText: vi.fn().mockReturnValue(null),
    persistLocalState: vi.fn().mockResolvedValue(undefined),
    saveMetadata: vi.fn().mockResolvedValue(undefined),
    saveFidelityReport: vi.fn().mockResolvedValue(undefined),
    saveScenarios: vi.fn().mockResolvedValue(undefined),
  };
}

describe("BuildOrchestrator", () => {
  let mockPS: ReturnType<typeof createMockPolicyService>;
  let ui: ReturnType<typeof createMockUI>;
  let state: ReturnType<typeof createMockState>;
  let orchestrator: BuildOrchestrator;

  beforeEach(() => {
    buildAssetsStore.clear();
    mockPS = createMockPolicyService();
    ui = createMockUI();
    state = createMockState();
    orchestrator = new BuildOrchestrator(
      mockPS as unknown as PolicyService,
      ui,
      state,
    );
  });

  // ── loadBuildAssets happy path ──

  describe("loadBuildAssets happy path", () => {
    it("fetches all 5 asset types in parallel and populates buildAssetsStore", async () => {
      const definition = { version: "1.0", rules: [], variables: [], types: [] };
      mockPS.getBuildAssets
        .mockResolvedValueOnce({ policyDefinition: definition }) // POLICY_DEFINITION
        .mockResolvedValueOnce({ buildLog: [] })                 // BUILD_LOG
        .mockResolvedValueOnce({ qualityReport: {} })            // QUALITY_REPORT
        .mockResolvedValueOnce(null)                             // FIDELITY_REPORT
        .mockResolvedValueOnce(null);                            // POLICY_SCENARIOS

      await orchestrator.loadBuildAssets(ARN, BUILD_ID);

      expect(mockPS.getBuildAssets).toHaveBeenCalledTimes(5);
      const assets = buildAssetsStore.get();
      expect(assets).not.toBeNull();
      expect(assets!.buildWorkflowId).toBe(BUILD_ID);
      expect(assets!.policyDefinition).toBeDefined();
    });
  });

  // ── loadBuildAssets partial failure ──

  describe("loadBuildAssets partial failure", () => {
    it("some assets fail, others still loaded, no throw", async () => {
      const definition = { version: "1.0", rules: [], variables: [], types: [] };
      mockPS.getBuildAssets
        .mockResolvedValueOnce({ policyDefinition: definition }) // POLICY_DEFINITION succeeds
        .mockRejectedValueOnce(new Error("Network error"))      // BUILD_LOG fails
        .mockRejectedValueOnce(new Error("Timeout"))            // QUALITY_REPORT fails
        .mockResolvedValueOnce(null)                             // FIDELITY_REPORT
        .mockResolvedValueOnce(null);                            // POLICY_SCENARIOS

      // Should not throw
      await orchestrator.loadBuildAssets(ARN, BUILD_ID);

      const assets = buildAssetsStore.get();
      expect(assets).not.toBeNull();
      expect(assets!.policyDefinition).toBeDefined();
      expect(assets!.buildLog).toBeNull();
      expect(assets!.qualityReport).toBeNull();
    });
  });

  // ── loadBuildAssets fidelity fallback ──

  describe("loadBuildAssets fidelity fallback", () => {
    it("API returns no fidelity report, falls back to cached local state", async () => {
      const cachedReport = { coverageScore: 0.8, accuracyScore: 0.9, ruleReports: [], variableReports: [] };
      (state.getLocalState as ReturnType<typeof vi.fn>).mockReturnValue({
        fidelityReports: { [BUILD_ID]: cachedReport },
      });

      mockPS.getBuildAssets.mockResolvedValue(null);

      await orchestrator.loadBuildAssets(ARN, BUILD_ID);

      const assets = buildAssetsStore.get();
      expect(assets!.fidelityReport).toEqual(cachedReport);
    });
  });

  // ── loadBuildAssets scenarios ──

  describe("loadBuildAssets scenarios", () => {
    it("parses and selects scenarios, persists to local state", async () => {
      // Provide a non-null local state so saveScenariosToLocalState proceeds
      (state.getLocalState as ReturnType<typeof vi.fn>).mockReturnValue({});

      const scenariosAsset = {
        policyScenarios: [
          { expression: "(= x true)", alternateExpression: "x is true", ruleIds: ["r1"] },
          { expression: "(= y 1)", alternateExpression: "y is 1", ruleIds: ["r2"] },
        ],
      };
      mockPS.getBuildAssets
        .mockResolvedValueOnce(null)  // POLICY_DEFINITION
        .mockResolvedValueOnce(null)  // BUILD_LOG
        .mockResolvedValueOnce(null)  // QUALITY_REPORT
        .mockResolvedValueOnce(null)  // FIDELITY_REPORT
        .mockResolvedValueOnce(scenariosAsset); // POLICY_SCENARIOS

      await orchestrator.loadBuildAssets(ARN, BUILD_ID);

      const assets = buildAssetsStore.get();
      expect(assets!.policyScenarios).toHaveLength(2);
      expect(state.saveScenarios).toHaveBeenCalled();
      expect(state.persistLocalState).toHaveBeenCalled();
    });
  });

  // ── clearAllPollingIntervals ──

  describe("clearAllPollingIntervals", () => {
    it("all active intervals cleared", () => {
      // Access private field to add fake intervals
      const intervals = (orchestrator as any).activePollingIntervals as Set<ReturnType<typeof setInterval>>;
      const id1 = setInterval(() => {}, 100000);
      const id2 = setInterval(() => {}, 100000);
      intervals.add(id1);
      intervals.add(id2);

      orchestrator.clearAllPollingIntervals();

      expect(intervals.size).toBe(0);
      // Clean up just in case
      clearInterval(id1);
      clearInterval(id2);
    });
  });
});
