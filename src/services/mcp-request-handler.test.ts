/**
 * Integration tests for MCP request handler and dispatchToolCall.
 *
 * Tests tool routing, approval code validation, error handling,
 * and the handleMcpRequest wrapper.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleMcpRequest } from "./mcp-request-handler";
import { POLICY_TOOLS, SEARCH_TOOLS, dispatchToolCall } from "./policy-mcp-server";
import type { PolicyWorkflowService } from "./policy-workflow-service";
import { BuildFailedError } from "./policy-workflow-service";

// Mock approval-code-store so we can control validation
vi.mock("./approval-code-store", () => ({
  consumeApprovalCode: vi.fn().mockReturnValue(true),
}));

// Mock retry to avoid real delays
vi.mock("../utils/retry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/retry")>();
  return {
    ...actual,
    withRetry: async <T>(fn: () => Promise<T>) => fn(),
  };
});

const ARN = "arn:aws:bedrock:us-west-2:123456789:policy/test-policy";

function createMockWorkflowService(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    generateFidelityReport: vi.fn().mockResolvedValue({
      buildWorkflowId: "bw-1",
      report: { coverageScore: 0.9, accuracyScore: 0.85, ruleReports: [], variableReports: [] },
      sourceDocumentText: "doc text",
    }),
    addRules: vi.fn().mockResolvedValue({
      policyDefinition: { version: "1.0", rules: [{ ruleId: "r1" }], variables: [], types: [] },
      buildWorkflowId: "bw-2",
      buildLog: [],
      buildErrors: [],
    }),
    addVariables: vi.fn().mockResolvedValue({
      policyDefinition: { version: "1.0", rules: [], variables: [{ name: "x" }], types: [] },
      buildWorkflowId: "bw-3",
      buildLog: [],
      buildErrors: [],
    }),
    executeTests: vi.fn().mockResolvedValue([
      { testCaseId: "tc-1", passed: true, actualResult: "VALID", findings: [] },
    ]),
    updateTests: vi.fn().mockResolvedValue([
      { testCaseId: "tc-1", guardContent: "g", queryContent: "q", expectedResult: "VALID" },
    ]),
    deleteTests: vi.fn().mockResolvedValue(["tc-1"]),
    updateVariables: vi.fn().mockResolvedValue({
      policyDefinition: { version: "1.0", rules: [], variables: [], types: [] },
      buildWorkflowId: "bw-4",
      buildLog: [],
      buildErrors: [],
    }),
    deleteRules: vi.fn().mockResolvedValue({
      policyDefinition: { version: "1.0", rules: [], variables: [], types: [] },
      buildWorkflowId: "bw-5",
      buildLog: [],
      buildErrors: [],
    }),
    deleteVariables: vi.fn().mockResolvedValue({
      policyDefinition: { version: "1.0", rules: [], variables: [], types: [] },
      buildWorkflowId: "bw-6",
      buildLog: [],
      buildErrors: [],
    }),
  };
}

describe("MCP Request Handler", () => {
  let mockWS: ReturnType<typeof createMockWorkflowService>;
  let originalEnv: string | undefined;

  beforeEach(() => {
    mockWS = createMockWorkflowService();
    originalEnv = process.env.APPROVAL_CODE_FILE;
    process.env.APPROVAL_CODE_FILE = "/tmp/test-approval-codes.json";
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.APPROVAL_CODE_FILE;
    else process.env.APPROVAL_CODE_FILE = originalEnv;
  });

  // ── handleMcpRequest: tools/list ──

  describe("tools/list", () => {
    it("returns all POLICY_TOOLS definitions", async () => {
      const res = await handleMcpRequest(
        { id: 1, method: "tools/list" },
        mockWS as unknown as PolicyWorkflowService,
        null,
      );

      expect(res.id).toBe(1);
      const allTools = [...POLICY_TOOLS, ...SEARCH_TOOLS];
      expect((res.result as any).tools).toEqual(allTools);
      expect((res.result as any).tools.length).toBeGreaterThan(0);
    });
  });

  // ── handleMcpRequest: initialize ──

  describe("initialize", () => {
    it("returns protocol version and server info", async () => {
      const res = await handleMcpRequest(
        { id: 1, method: "initialize" },
        mockWS as unknown as PolicyWorkflowService,
        null,
      );

      expect((res.result as any).protocolVersion).toBe("2024-11-05");
      expect((res.result as any).serverInfo.name).toBe("architect-policy-tools");
    });
  });

  // ── dispatchToolCall: generate_fidelity_report ──

  describe("generate_fidelity_report", () => {
    it("dispatches to workflowService and returns formatted result", async () => {
      const result = await dispatchToolCall(
        mockWS as unknown as PolicyWorkflowService,
        null,
        "generate_fidelity_report",
        { policyArn: ARN },
      );

      expect(mockWS.generateFidelityReport).toHaveBeenCalledWith(ARN, expect.any(Function));
      expect(result.isError).toBeUndefined();
      const text = JSON.parse(result.content[0].text);
      expect(text.coverageScore).toBe(0.9);
    });
  });

  // ── dispatchToolCall: add_rules ──

  describe("add_rules", () => {
    it("validates approval code, dispatches, returns definition", async () => {
      const result = await dispatchToolCall(
        mockWS as unknown as PolicyWorkflowService,
        null,
        "add_rules",
        { policyArn: ARN, rules: [{ expression: "(assert true)" }], approvalCode: "valid-code" },
      );

      expect(mockWS.addRules).toHaveBeenCalled();
      expect(result.isError).toBeUndefined();
      const text = JSON.parse(result.content[0].text);
      expect(text.ruleCount).toBe(1);
    });
  });

  // ── dispatchToolCall: add_rules without approval ──

  describe("add_rules without approval", () => {
    it("returns APPROVAL_REJECTION_MESSAGE", async () => {
      const result = await dispatchToolCall(
        mockWS as unknown as PolicyWorkflowService,
        null,
        "add_rules",
        { policyArn: ARN, rules: [{ expression: "(assert true)" }] },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("APPROVAL REQUIRED");
      expect(mockWS.addRules).not.toHaveBeenCalled();
    });
  });

  // ── dispatchToolCall: add_rules with consumed code ──

  describe("add_rules with consumed code", () => {
    it("returns INVALID_APPROVAL_CODE message", async () => {
      const { consumeApprovalCode } = await import("./approval-code-store");
      (consumeApprovalCode as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);

      const result = await dispatchToolCall(
        mockWS as unknown as PolicyWorkflowService,
        null,
        "add_rules",
        { policyArn: ARN, rules: [{ expression: "(assert true)" }], approvalCode: "used-code" },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("INVALID APPROVAL CODE");
    });
  });

  // ── dispatchToolCall: unknown tool ──

  describe("unknown tool", () => {
    it("returns error", async () => {
      const result = await dispatchToolCall(
        mockWS as unknown as PolicyWorkflowService,
        null,
        "nonexistent_tool",
        {},
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown tool");
    });
  });

  // ── dispatchToolCall: BuildFailedError ──

  describe("BuildFailedError handling", () => {
    it("returns error with build log summary", async () => {
      mockWS.addRules.mockRejectedValueOnce(
        new BuildFailedError("bw-fail", "FAILED", [
          { annotation: { addRule: {} }, status: "FAILED", buildSteps: [{ context: {}, messages: [{ messageType: "ERROR", message: "bad rule" }] }] },
        ]),
      );

      const result = await dispatchToolCall(
        mockWS as unknown as PolicyWorkflowService,
        null,
        "add_rules",
        { policyArn: ARN, rules: [{ expression: "bad" }], approvalCode: "code" },
      );

      expect(result.isError).toBe(true);
      const text = JSON.parse(result.content[0].text);
      expect(text.error).toContain("FAILED");
      expect(text.buildWorkflowId).toBe("bw-fail");
    });
  });

  // ── dispatchToolCall: execute_tests ──

  describe("execute_tests", () => {
    it("dispatches to workflowService and returns results", async () => {
      const result = await dispatchToolCall(
        mockWS as unknown as PolicyWorkflowService,
        null,
        "execute_tests",
        { policyArn: ARN, testCaseIds: ["tc-1"] },
      );

      expect(mockWS.executeTests).toHaveBeenCalledWith(ARN, ["tc-1"], expect.any(Function));
      const text = JSON.parse(result.content[0].text);
      expect(text.passed).toBe(1);
      expect(text.totalTests).toBe(1);
    });
  });

  // ── dispatchToolCall: add_variables type validation ──

  describe("add_variables type validation", () => {
    it("rejects invalid type 'boolean' at dispatch level", async () => {
      const result = await dispatchToolCall(
        mockWS as unknown as PolicyWorkflowService,
        null,
        "add_variables",
        { policyArn: ARN, variables: [{ name: "x", type: "boolean", description: "test" }], approvalCode: "code" },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("BOOL");
      expect(mockWS.addVariables).not.toHaveBeenCalled();
    });
  });

  // ── handleMcpRequest: tools/call with missing tool name ──

  describe("tools/call with missing tool name", () => {
    it("returns error for missing tool name", async () => {
      const res = await handleMcpRequest(
        { id: 1, method: "tools/call", params: {} },
        mockWS as unknown as PolicyWorkflowService,
        null,
      );

      expect(res.error).toBeDefined();
      expect(res.error!.message).toContain("Missing or invalid tool name");
    });
  });
});
