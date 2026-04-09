/**
 * Integration tests for PolicyService with mocked AWS SDK.
 *
 * Mocks BedrockClient.send() with command-based dispatch to verify
 * that PolicyService sends the correct commands and maps responses.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  CreateAutomatedReasoningPolicyCommand,
  GetAutomatedReasoningPolicyCommand,
  ListAutomatedReasoningPoliciesCommand,
  ExportAutomatedReasoningPolicyVersionCommand,
  UpdateAutomatedReasoningPolicyCommand,
  StartAutomatedReasoningPolicyBuildWorkflowCommand,
  GetAutomatedReasoningPolicyBuildWorkflowCommand,
  DeleteAutomatedReasoningPolicyBuildWorkflowCommand,
  ListAutomatedReasoningPolicyBuildWorkflowsCommand,
  GetAutomatedReasoningPolicyBuildWorkflowResultAssetsCommand,
  StartAutomatedReasoningPolicyTestWorkflowCommand,
  GetAutomatedReasoningPolicyTestResultCommand,
} from "@aws-sdk/client-bedrock";
import { PolicyService } from "./policy-service";
import type { PolicyServiceConfig } from "./policy-service";

const ARN = "arn:aws:bedrock:us-west-2:123456789:policy/test-policy";
const BUILD_ID = "bw-test-123";

function createMockClient() {
  return { send: vi.fn() } as unknown as import("@aws-sdk/client-bedrock").BedrockClient;
}

function createService(client: ReturnType<typeof createMockClient>) {
  return new PolicyService({ client } as PolicyServiceConfig);
}

describe("PolicyService + AWS SDK", () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let service: PolicyService;

  beforeEach(() => {
    mockClient = createMockClient();
    service = createService(mockClient);
  });

  // ── createPolicy ──

  describe("createPolicy", () => {
    it("sends CreateAutomatedReasoningPolicyCommand and returns ARN", async () => {
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ policyArn: ARN });

      const result = await service.createPolicy("my-policy");

      expect(result).toBe(ARN);
      const call = (mockClient.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call).toBeInstanceOf(CreateAutomatedReasoningPolicyCommand);
      expect(call.input.name).toBe("my-policy");
    });
  });

  // ── listPolicies ──

  describe("listPolicies", () => {
    it("sends ListCommand and maps response to PolicyInfo[]", async () => {
      const now = new Date();
      const earlier = new Date(now.getTime() - 60_000);
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        automatedReasoningPolicySummaries: [
          { policyArn: "arn:1", name: "older", createdAt: earlier, updatedAt: earlier },
          { policyArn: "arn:2", name: "newer", createdAt: now, updatedAt: now },
        ],
      });

      const result = await service.listPolicies();

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("newer"); // sorted by most recent
      expect(result[1].name).toBe("older");
      const call = (mockClient.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call).toBeInstanceOf(ListAutomatedReasoningPoliciesCommand);
    });
  });

  // ── exportPolicyDefinition ──

  describe("exportPolicyDefinition", () => {
    it("sends ExportCommand and returns definition", async () => {
      const definition = { version: "1.0", rules: [], variables: [], types: [] };
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ policyDefinition: definition });

      const result = await service.exportPolicyDefinition(ARN);

      expect(result).toEqual(definition);
      const call = (mockClient.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call).toBeInstanceOf(ExportAutomatedReasoningPolicyVersionCommand);
      expect(call.input.policyArn).toBe(ARN);
    });
  });

  // ── startBuild + pollBuild ──

  describe("startBuild + pollBuild", () => {
    it("sends StartCommand, polls with GetCommand, returns on COMPLETED", async () => {
      const send = mockClient.send as ReturnType<typeof vi.fn>;
      // startBuild
      send.mockResolvedValueOnce({ buildWorkflowId: BUILD_ID });
      // pollBuild: first call returns BUILDING, second returns COMPLETED
      send.mockResolvedValueOnce({
        buildWorkflowId: BUILD_ID,
        buildWorkflowType: "REFINE_POLICY",
        status: "BUILDING",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      send.mockResolvedValueOnce({
        buildWorkflowId: BUILD_ID,
        buildWorkflowType: "REFINE_POLICY",
        status: "COMPLETED",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const buildId = await service.startBuild(ARN, "REFINE_POLICY", {
        policyDefinition: { version: "1.0", rules: [], variables: [], types: [] },
      } as any);
      expect(buildId).toBe(BUILD_ID);

      const build = await service.pollBuild(ARN, BUILD_ID, 1, 10);
      expect(build.status).toBe("COMPLETED");

      expect(send.mock.calls[0][0]).toBeInstanceOf(StartAutomatedReasoningPolicyBuildWorkflowCommand);
      expect(send.mock.calls[1][0]).toBeInstanceOf(GetAutomatedReasoningPolicyBuildWorkflowCommand);
    });
  });

  // ── pollBuild timeout ──

  describe("pollBuild timeout", () => {
    it("exceeds max attempts and throws timeout error", async () => {
      const send = mockClient.send as ReturnType<typeof vi.fn>;
      // Always return BUILDING
      send.mockResolvedValue({
        buildWorkflowId: BUILD_ID,
        buildWorkflowType: "REFINE_POLICY",
        status: "BUILDING",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await expect(service.pollBuild(ARN, BUILD_ID, 1, 3)).rejects.toThrow("timed out");
    });
  });

  // ── pollBuild failure ──

  describe("pollBuild failure", () => {
    it("build reaches FAILED status, returns build with FAILED status", async () => {
      const send = mockClient.send as ReturnType<typeof vi.fn>;
      send.mockResolvedValueOnce({
        buildWorkflowId: BUILD_ID,
        buildWorkflowType: "REFINE_POLICY",
        status: "FAILED",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const build = await service.pollBuild(ARN, BUILD_ID, 1, 10);
      expect(build.status).toBe("FAILED");
    });
  });

  // ── getBuildAssets ──

  describe("getBuildAssets", () => {
    it("sends GetResultAssetsCommand with correct asset type", async () => {
      const assets = { policyDefinition: { version: "1.0" } };
      (mockClient.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ buildWorkflowAssets: assets });

      const result = await service.getBuildAssets(ARN, BUILD_ID, "POLICY_DEFINITION");

      expect(result).toEqual(assets);
      const call = (mockClient.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call).toBeInstanceOf(GetAutomatedReasoningPolicyBuildWorkflowResultAssetsCommand);
      expect(call.input.assetType).toBe("POLICY_DEFINITION");
    });
  });

  // ── manageBuildSlot ──

  describe("manageBuildSlot", () => {
    it("lists builds and deletes oldest completed when at limit", async () => {
      const send = mockClient.send as ReturnType<typeof vi.fn>;
      const now = new Date();
      const earlier = new Date(now.getTime() - 60_000);

      // listBuilds
      send.mockResolvedValueOnce({
        automatedReasoningPolicyBuildWorkflowSummaries: [
          { buildWorkflowId: "bw-old", buildWorkflowType: "REFINE_POLICY", status: "COMPLETED", createdAt: earlier, updatedAt: earlier },
          { buildWorkflowId: "bw-new", buildWorkflowType: "REFINE_POLICY", status: "BUILDING", createdAt: now, updatedAt: now },
        ],
      });
      // deleteBuild
      send.mockResolvedValueOnce({});

      await service.manageBuildSlot(ARN);

      expect(send).toHaveBeenCalledTimes(2);
      const deleteCall = send.mock.calls[1][0];
      expect(deleteCall).toBeInstanceOf(DeleteAutomatedReasoningPolicyBuildWorkflowCommand);
      expect(deleteCall.input.buildWorkflowId).toBe("bw-old");
    });
  });

  // ── Throttling recovery ──

  describe("throttling recovery", () => {
    it("send() throws ThrottlingException, retries with backoff in pollBuild", async () => {
      const send = mockClient.send as ReturnType<typeof vi.fn>;
      const throttleError = new Error("Rate exceeded");
      throttleError.name = "ThrottlingException";

      // First call throttles, second succeeds
      send.mockRejectedValueOnce(throttleError);
      send.mockResolvedValueOnce({
        buildWorkflowId: BUILD_ID,
        buildWorkflowType: "REFINE_POLICY",
        status: "COMPLETED",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const build = await service.pollBuild(ARN, BUILD_ID, 1, 10);
      expect(build.status).toBe("COMPLETED");
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  // ── onTestsExecuted ──

  describe("onTestsExecuted", () => {
    it("listener called after emitTestsExecuted", () => {
      const listener = vi.fn();
      service.onTestsExecuted(listener);

      service.emitTestsExecuted(ARN, BUILD_ID);

      expect(listener).toHaveBeenCalledWith(ARN, BUILD_ID);
    });

    it("unsubscribe stops notifications", () => {
      const listener = vi.fn();
      const unsub = service.onTestsExecuted(listener);
      unsub();

      service.emitTestsExecuted(ARN, BUILD_ID);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ── runTests ──

  describe("runTests", () => {
    it("sends StartTestWorkflowCommand", async () => {
      const send = mockClient.send as ReturnType<typeof vi.fn>;
      send.mockResolvedValueOnce({});

      await service.runTests(ARN, BUILD_ID, ["tc-1", "tc-2"]);

      const call = send.mock.calls[0][0];
      expect(call).toBeInstanceOf(StartAutomatedReasoningPolicyTestWorkflowCommand);
      expect(call.input.buildWorkflowId).toBe(BUILD_ID);
    });
  });
});
