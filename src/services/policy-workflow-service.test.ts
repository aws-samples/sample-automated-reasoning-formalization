/**
 * Integration tests for PolicyWorkflowService with mocked PolicyService.
 *
 * Tests the full workflow orchestration: export → build slot → start build →
 * poll → fetch assets → update policy → return result.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  PolicyWorkflowService,
  BuildFailedError,
  BuildTimeoutError,
} from "./policy-workflow-service";
import type { PolicyService, BuildWorkflowInfo } from "./policy-service";
import { PollTimeoutError } from "./policy-service";

const ARN = "arn:aws:bedrock:us-west-2:123456789:policy/test-policy";
const BUILD_ID = "bw-test-456";

const MOCK_DEFINITION = {
  version: "1.0",
  rules: [{ ruleId: "r1", expression: "(assert true)", description: "test" }],
  variables: [{ name: "x", type: "BOOL", description: "a var" }],
  types: [],
};

const MOCK_BUILD_COMPLETED: BuildWorkflowInfo = {
  buildWorkflowId: BUILD_ID,
  buildWorkflowType: "REFINE_POLICY" as any,
  status: "COMPLETED" as any,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function createMockPolicyService(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    exportPolicyDefinition: vi.fn().mockResolvedValue(MOCK_DEFINITION),
    manageBuildSlot: vi.fn().mockResolvedValue(undefined),
    startBuild: vi.fn().mockResolvedValue(BUILD_ID),
    pollBuild: vi.fn().mockResolvedValue(MOCK_BUILD_COMPLETED),
    getBuildAssets: vi.fn().mockResolvedValue({
      policyDefinition: MOCK_DEFINITION,
    }),
    updatePolicy: vi.fn().mockResolvedValue(undefined),
    listBuilds: vi.fn().mockResolvedValue([MOCK_BUILD_COMPLETED]),
    findLatestPolicyBuild: vi.fn().mockReturnValue(MOCK_BUILD_COMPLETED),
    getTestCase: vi.fn().mockResolvedValue({
      testCaseId: "tc-1",
      guardContent: "guard",
      queryContent: "query",
      expectedAggregatedFindingsResult: "VALID",
    }),
    runTests: vi.fn().mockResolvedValue(undefined),
    getTestResult: vi.fn().mockResolvedValue({
      testResult: {
        testRunStatus: "COMPLETED",
        aggregatedTestFindingsResult: "VALID",
        testCase: { expectedAggregatedFindingsResult: "VALID" },
        testFindings: [],
      },
    }),
    emitTestsExecuted: vi.fn(),
    startFidelityReportBuild: vi.fn().mockResolvedValue(BUILD_ID),
    updateTestCase: vi.fn().mockResolvedValue(undefined),
    deleteTestCase: vi.fn().mockResolvedValue(undefined),
    deleteBuild: vi.fn().mockResolvedValue(undefined),
  };
}

describe("PolicyWorkflowService + PolicyService", () => {
  let mockPS: ReturnType<typeof createMockPolicyService>;
  let workflow: PolicyWorkflowService;

  beforeEach(() => {
    mockPS = createMockPolicyService();
    workflow = new PolicyWorkflowService(mockPS as unknown as PolicyService);
  });

  // ── addRules happy path ──

  describe("addRules happy path", () => {
    it("exports → ensures build slot → starts REFINE_POLICY → polls → fetches assets → updates → returns", async () => {
      const result = await workflow.addRules(ARN, [{ expression: "(assert true)" }], undefined, {
        buildIntervalMs: 1,
        buildMaxAttempts: 2,
      });

      expect(mockPS.exportPolicyDefinition).toHaveBeenCalledWith(ARN);
      expect(mockPS.manageBuildSlot).toHaveBeenCalledWith(ARN, "REFINE_POLICY");
      expect(mockPS.startBuild).toHaveBeenCalledWith(ARN, "REFINE_POLICY", expect.any(Object));
      expect(mockPS.pollBuild).toHaveBeenCalled();
      expect(mockPS.getBuildAssets).toHaveBeenCalled();
      expect(mockPS.updatePolicy).toHaveBeenCalledWith(ARN, MOCK_DEFINITION);
      expect(result.policyDefinition.rules).toHaveLength(1);
      expect(result.buildWorkflowId).toBe(BUILD_ID);
    });
  });

  // ── addRules validation ──

  describe("addRules validation", () => {
    it("throws when no rules provided", async () => {
      await expect(workflow.addRules(ARN, [])).rejects.toThrow("At least one rule");
    });

    it("throws when more than 10 rules", async () => {
      const rules = Array.from({ length: 11 }, (_, i) => ({ expression: `(rule ${i})` }));
      await expect(workflow.addRules(ARN, rules)).rejects.toThrow("Maximum 10");
    });
  });

  // ── addRules build failure ──

  describe("addRules build failure", () => {
    it("throws BuildFailedError with build log when build fails", async () => {
      mockPS.pollBuild.mockResolvedValueOnce({
        ...MOCK_BUILD_COMPLETED,
        status: "FAILED",
      });
      mockPS.getBuildAssets.mockResolvedValueOnce({
        buildLog: [{ annotation: { addRule: {} }, status: "FAILED", buildSteps: [] }],
      });

      await expect(
        workflow.addRules(ARN, [{ expression: "(assert false)" }], undefined, {
          buildIntervalMs: 1,
          buildMaxAttempts: 2,
        }),
      ).rejects.toThrow(BuildFailedError);
    });
  });

  // ── addRules build timeout ──

  describe("addRules build timeout", () => {
    it("throws BuildTimeoutError when polling exceeds limit", async () => {
      mockPS.pollBuild.mockRejectedValueOnce(new PollTimeoutError("bw-test-456"));

      await expect(
        workflow.addRules(ARN, [{ expression: "(assert true)" }], undefined, {
          buildIntervalMs: 1,
          buildMaxAttempts: 1,
        }),
      ).rejects.toThrow(BuildTimeoutError);
    });
  });

  // ── addVariables type validation ──

  describe("addVariables type validation", () => {
    it("rejects invalid types like 'boolean' before API call", async () => {
      await expect(
        workflow.addVariables(ARN, [{ name: "x", type: "boolean", description: "test" }]),
      ).rejects.toThrow(/BOOL/);

      expect(mockPS.startBuild).not.toHaveBeenCalled();
    });

    it("rejects 'string' type", async () => {
      await expect(
        workflow.addVariables(ARN, [{ name: "x", type: "string", description: "test" }]),
      ).rejects.toThrow(/custom type/);
    });

    it("accepts valid built-in types", async () => {
      const result = await workflow.addVariables(
        ARN,
        [{ name: "x", type: "BOOL", description: "test" }],
        undefined,
        { buildIntervalMs: 1, buildMaxAttempts: 2 },
      );
      expect(result.policyDefinition).toBeDefined();
    });
  });

  // ── executeTests ──

  describe("executeTests", () => {
    it("finds latest build → fetches test cases → runs → polls → merges output", async () => {
      const results = await workflow.executeTests(ARN, ["tc-1"], undefined, {
        testIntervalMs: 1,
        testMaxAttempts: 2,
      });

      expect(mockPS.listBuilds).toHaveBeenCalledWith(ARN);
      expect(mockPS.findLatestPolicyBuild).toHaveBeenCalled();
      expect(mockPS.getTestCase).toHaveBeenCalledWith(ARN, "tc-1");
      expect(mockPS.runTests).toHaveBeenCalledWith(ARN, BUILD_ID, ["tc-1"]);
      expect(mockPS.emitTestsExecuted).toHaveBeenCalledWith(ARN, BUILD_ID);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].actualResult).toBe("VALID");
    });

    it("throws when no completed build found", async () => {
      mockPS.findLatestPolicyBuild.mockReturnValueOnce(undefined);

      await expect(workflow.executeTests(ARN, ["tc-1"])).rejects.toThrow("No completed build");
    });

    it("throws when no test case IDs provided", async () => {
      await expect(workflow.executeTests(ARN, [])).rejects.toThrow("At least one test case ID");
    });
  });

  // ── generateFidelityReport ──

  describe("generateFidelityReport", () => {
    it("exports definition → starts fidelity build → polls → parses report", async () => {
      const fidelityReport = {
        coverageScore: 0.85,
        accuracyScore: 0.9,
        ruleReports: [],
        variableReports: [],
        documentSources: [],
      };
      mockPS.getBuildAssets.mockResolvedValueOnce(undefined); // build log fetch
      mockPS.getBuildAssets.mockResolvedValueOnce({ fidelityReport });

      // The method calls getBuildAssets for FIDELITY_REPORT
      // We need to reset and set up the mock properly
      mockPS.getBuildAssets.mockReset();
      mockPS.getBuildAssets.mockResolvedValueOnce({ fidelityReport });

      const result = await workflow.generateFidelityReport(ARN, undefined, undefined, {
        buildIntervalMs: 1,
        buildMaxAttempts: 2,
      });

      expect(mockPS.exportPolicyDefinition).toHaveBeenCalledWith(ARN);
      expect(mockPS.startFidelityReportBuild).toHaveBeenCalled();
      expect(mockPS.pollBuild).toHaveBeenCalled();
      expect(result.report.coverageScore).toBe(0.85);
      expect(result.buildWorkflowId).toBe(BUILD_ID);
    });
  });

  // ── updateTests ──

  describe("updateTests", () => {
    it("fetches existing test → applies partial update → preserves unchanged fields", async () => {
      const updatedAt = new Date("2025-01-01");
      mockPS.getTestCase.mockResolvedValueOnce({
        testCaseId: "tc-1",
        guardContent: "old guard",
        queryContent: "old query",
        expectedAggregatedFindingsResult: "VALID",
        updatedAt,
      });

      await workflow.updateTests(ARN, [{ testCaseId: "tc-1", guardContent: "new guard" }]);

      expect(mockPS.getTestCase).toHaveBeenCalledWith(ARN, "tc-1");
      // updateTestCase(policyArn, testCaseId, guardContent, queryContent, expectedResult, updatedAt)
      expect(mockPS.updateTestCase).toHaveBeenCalledWith(
        ARN, "tc-1", "new guard", "old query", "VALID", updatedAt,
      );
    });
  });

  // ── deleteTests ──

  describe("deleteTests", () => {
    it("fetches test for updatedAt timestamp → deletes", async () => {
      const updatedAt = new Date("2025-01-01");
      mockPS.getTestCase.mockResolvedValueOnce({
        testCaseId: "tc-1",
        updatedAt,
      });

      const deleted = await workflow.deleteTests(ARN, ["tc-1"]);

      expect(mockPS.getTestCase).toHaveBeenCalledWith(ARN, "tc-1");
      expect(mockPS.deleteTestCase).toHaveBeenCalledWith(ARN, "tc-1", updatedAt);
      expect(deleted).toEqual(["tc-1"]);
    });
  });

  // ── Build slot management ──

  describe("build slot management", () => {
    it("calls manageBuildSlot before starting a new build", async () => {
      await workflow.addRules(ARN, [{ expression: "(assert true)" }], undefined, {
        buildIntervalMs: 1,
        buildMaxAttempts: 2,
      });

      // manageBuildSlot is called before startBuild
      const manageBuildSlotOrder = mockPS.manageBuildSlot.mock.invocationCallOrder[0];
      const startBuildOrder = mockPS.startBuild.mock.invocationCallOrder[0];
      expect(manageBuildSlotOrder).toBeLessThan(startBuildOrder);
    });
  });

  // ── Progress callback ──

  describe("progress callback", () => {
    it("calls onProgress at each workflow step", async () => {
      const onProgress = vi.fn();

      await workflow.addRules(ARN, [{ expression: "(assert true)" }], onProgress, {
        buildIntervalMs: 1,
        buildMaxAttempts: 2,
      });

      expect(onProgress).toHaveBeenCalled();
      const messages = onProgress.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(messages.some((m: string) => m.includes("Exporting"))).toBe(true);
      expect(messages.some((m: string) => m.includes("refinement") || m.includes("Building"))).toBe(true);
    });
  });
});
