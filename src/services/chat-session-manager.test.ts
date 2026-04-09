/**
 * Integration tests for ChatSessionManager with mocked ChatService and IO callbacks.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChatSessionManager } from "./chat-session-manager";
import type { ChatSessionUI, ChatSessionState, ChatSessionIO } from "./chat-session-manager";
import { ChatService } from "./chat-service";

// Mock ChatService so we control its behavior
vi.mock("./chat-service", () => {
  function MockChatService() {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      cancel: vi.fn(),
      sendPolicyMessage: vi.fn().mockResolvedValue({ id: "m1", role: "assistant", content: "ok", timestamp: 1 }),
      setMcpServers: vi.fn(),
      onUpdate: undefined as any,
      testContext: null as string | null,
    };
  }
  return { ChatService: MockChatService };
});

// Mock streamAgentMessage to avoid real streaming
vi.mock("../utils/agent-stream", () => ({
  streamAgentMessage: vi.fn().mockResolvedValue(undefined),
}));

function createMockUI(): ChatSessionUI {
  let generation = 0;
  return {
    startStreaming: vi.fn(() => document.createElement("div")),
    pushStreamChunk: vi.fn(),
    endStreaming: vi.fn(),
    abortStreaming: vi.fn(),
    appendStatus: vi.fn(() => document.createElement("div")),
    clearMessages: vi.fn(() => { generation++; }),
    saveMessages: vi.fn().mockReturnValue("<div>chat html</div>"),
    restoreMessages: vi.fn(),
    noteToolCallStarted: vi.fn(),
    noteToolActivity: vi.fn(),
    streamGeneration: vi.fn(() => generation),
  };
}

function createMockState(): ChatSessionState {
  return {
    getPolicyArn: vi.fn().mockReturnValue("arn:test"),
    getPolicyContext: vi.fn().mockReturnValue({ policyArn: "arn:test" }),
  };
}

function createMockIO(): ChatSessionIO {
  return {
    getMcpServerPath: vi.fn().mockResolvedValue("/path/to/mcp-server.js"),
    getNodeCommand: vi.fn().mockResolvedValue("node"),
    getApprovalCodeFilePath: vi.fn().mockResolvedValue("/tmp/approval-codes.json"),
    getContextIndexFilePath: vi.fn().mockResolvedValue("/tmp/context-index.json"),
    getRegion: vi.fn().mockReturnValue("us-west-2"),
  };
}

describe("ChatSessionManager", () => {
  let ui: ReturnType<typeof createMockUI>;
  let state: ReturnType<typeof createMockState>;
  let io: ReturnType<typeof createMockIO>;
  let manager: ChatSessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    ui = createMockUI();
    state = createMockState();
    io = createMockIO();
    manager = new ChatSessionManager(ui, state, io);
  });

  // ── activeChatService ──

  describe("activeChatService", () => {
    it("returns policyChatService when no test session active", () => {
      expect(manager.activeChatService()).toBe(manager.policyChatService);
    });

    it("returns testChatService when active", () => {
      const testService = new ChatService();
      manager.testChatService = testService;
      expect(manager.activeChatService()).toBe(testService);
    });
  });

  // ── startTestChatSession ──

  describe("startTestChatSession", () => {
    it("creates new ChatService, configures MCP, connects with test prompt, streams response", async () => {
      const testCase = {
        testCase: {
          testCaseId: "tc-1",
          guardContent: "guard",
          queryContent: "query",
          expectedAggregatedFindingsResult: "VALID",
        },
        testRunStatus: "COMPLETED",
        testRunResult: "VALID",
      };

      await manager.startTestChatSession(testCase as any);

      expect(ui.clearMessages).toHaveBeenCalled();
      expect(manager.testChatService).not.toBeNull();
      expect(manager.testChatService!.setMcpServers).toHaveBeenCalled();
      expect(manager.testChatService!.connect).toHaveBeenCalled();
      expect(ui.startStreaming).toHaveBeenCalled();
    });

    it("accepts an optional testUI parameter for per-context isolation", async () => {
      const testUI = createMockUI();
      const testCase = {
        testCase: { testCaseId: "tc-1", guardContent: "guard", queryContent: "query", expectedAggregatedFindingsResult: "VALID" },
        testRunStatus: "COMPLETED", testRunResult: "VALID",
      };

      await manager.startTestChatSession(testCase as any, testUI);

      expect(testUI.clearMessages).toHaveBeenCalled();
      expect(testUI.startStreaming).toHaveBeenCalled();
      expect(manager.testChatService).not.toBeNull();
    });
  });

  // ── cancelActivePrompt ──

  describe("cancelActivePrompt", () => {
    it("cancels in-flight prompt and cleans up streaming UI", () => {
      const mockChatService = new ChatService();
      const statusEl = document.createElement("div");
      document.body.appendChild(statusEl);
      const streamAnchor = document.createElement("div");

      manager.inFlightPrompt = {
        chatService: mockChatService,
        targetUI: ui,
        statusEl,
        streamAnchor,
        previousHandler: undefined,
      };

      manager.cancelActivePrompt();

      expect(mockChatService.cancel).toHaveBeenCalled();
      expect(ui.abortStreaming).toHaveBeenCalled();
      expect(manager.inFlightPrompt).toBeNull();
    });

    it("is a no-op when no in-flight prompt", () => {
      manager.cancelActivePrompt(); // should not throw
      expect(ui.abortStreaming).not.toHaveBeenCalled();
    });
  });

  // ── clearTestSessions ──

  describe("clearTestSessions", () => {
    it("disconnects all cached sessions and clears cache", () => {
      const cached1 = new ChatService();
      const cached2 = new ChatService();
      manager.testSessionCache.set("tc-1", { chatService: cached1, messagesHtml: "" });
      manager.testSessionCache.set("tc-2", { chatService: cached2, messagesHtml: "" });
      manager.testChatService = new ChatService();
      manager.activeTestId = "tc-1";

      manager.clearTestSessions();

      expect(cached1.disconnect).toHaveBeenCalled();
      expect(cached2.disconnect).toHaveBeenCalled();
      expect(manager.testSessionCache.size).toBe(0);
      expect(manager.testChatService).toBeNull();
      expect(manager.activeTestId).toBeNull();
    });
  });

  // ── MCP config lazy loading ──

  describe("MCP config lazy loading", () => {
    it("getMcpServerConfig called once, cached thereafter", async () => {
      const config1 = await manager.getMcpServerConfig();
      const config2 = await manager.getMcpServerConfig();

      expect(config1).toBe(config2);
      expect(io.getMcpServerPath).toHaveBeenCalledTimes(1);
      expect(io.getApprovalCodeFilePath).toHaveBeenCalledTimes(1);
      expect(config1[0].name).toBe("architect-policy-tools");
    });

    it("passes the IO region into the MCP server env", async () => {
      const config = await manager.getMcpServerConfig();
      expect(io.getRegion).toHaveBeenCalled();
      expect(config[0].env?.AWS_REGION).toBe("us-west-2");
    });
  });
});
