/**
 * Chat session lifecycle management.
 *
 * Manages the policy and test chat sessions, MCP configuration,
 * session caching, in-flight prompt tracking, and chat history persistence.
 */
import { ChatService } from "./chat-service";
import type { McpServerConfig } from "./acp-transport";
import { buildTestSystemPrompt } from "../prompts/test-system-prompt";
import { buildTestAnalysisPrompt } from "../utils/test-analysis";
import { streamAgentMessage } from "../utils/agent-stream";
import { mapToolToActivityLabel } from "../utils/tool-labels";
import type { TestCaseWithResult } from "../types";

export interface ChatSessionUI {
  startStreaming(): HTMLElement;
  pushStreamChunk(text: string): void;
  endStreaming(): void;
  abortStreaming(anchor: HTMLElement): void;
  appendStatus(text: string): HTMLElement;
  clearMessages(): void;
  saveMessages(): string;
  restoreMessages(html: string): void;
  noteToolCallStarted(): void;
  /** Signal tool activity with a friendly label for the UI indicator. */
  noteToolActivity(label: string): void;
  /** Return the current stream generation counter (for stale-callback detection). */
  streamGeneration(): number;
}

export interface ChatSessionState {
  getPolicyArn(): string | null;
  getPolicyContext(): Record<string, unknown> | undefined;
}

export interface ChatSessionIO {
  getMcpServerPath(): Promise<string>;
  getNodeCommand(): Promise<string>;
  getApprovalCodeFilePath(): Promise<string>;
  getContextIndexFilePath(): Promise<string>;
  /** AWS region — synchronous, fixed at process start. */
  getRegion(): string;
}

export class ChatSessionManager {
  /** Persistent policy chat session. */
  readonly policyChatService = new ChatService();
  /** Active test chat session — created on demand. */
  testChatService: ChatService | null = null;
  /** Currently selected test ID. */
  activeTestId: string | null = null;
  /** Cache of test chat sessions: testCaseId → { chatService, messagesHtml }. */
  readonly testSessionCache = new Map<string, { chatService: ChatService; messagesHtml: string }>();

  /** The "policy" chat ID used for the main policy conversation. */
  static readonly POLICY_CHAT_ID = "policy";

  /** In-flight prompt tracking for interruption support. */
  inFlightPrompt: {
    chatService: ChatService;
    targetUI: ChatSessionUI;
    statusEl: HTMLElement;
    streamAnchor: HTMLElement;
    previousHandler: ChatService["onUpdate"];
  } | null = null;

  /** Active test UI — set when a test session starts with a bound UI. */
  private activeTestUI: ChatSessionUI | null = null;

  private mcpServerConfigPromise: Promise<McpServerConfig[]> | null = null;
  private ui: ChatSessionUI;
  private state: ChatSessionState;
  private io: ChatSessionIO;

  constructor(ui: ChatSessionUI, state: ChatSessionState, io: ChatSessionIO) {
    this.ui = ui;
    this.state = state;
    this.io = io;
    this.policyChatService.onUpdate = undefined;
  }

  /** Returns whichever ChatService is currently active (test session takes priority). */
  activeChatService(): ChatService {
    return this.testChatService ?? this.policyChatService;
  }

  /** Returns whichever ChatSessionUI is currently active (test UI takes priority). */
  activeUI(): ChatSessionUI {
    return this.activeTestUI ?? this.ui;
  }

  /** Build the McpServerConfig lazily. */
  getMcpServerConfig(): Promise<McpServerConfig[]> {
    if (!this.mcpServerConfigPromise) {
      const region = this.io.getRegion();
      this.mcpServerConfigPromise = Promise.all([
        this.io.getMcpServerPath(),
        this.io.getNodeCommand(),
        this.io.getApprovalCodeFilePath(),
        this.io.getContextIndexFilePath(),
      ]).then(([serverPath, nodeCommand, approvalCodeFile, contextIndexFile]) => {
        const config: McpServerConfig[] = [{
          name: "architect-policy-tools",
          command: nodeCommand,
          args: [serverPath],
          env: {
            AWS_REGION: region,
            APPROVAL_CODE_FILE: approvalCodeFile,
            CONTEXT_INDEX_FILE: contextIndexFile,
          },
        }];
        console.log("[MCP config]", JSON.stringify({
          command: nodeCommand,
          serverPath,
          region,
          approvalCodeFile,
          contextIndexFile,
        }));
        return config;
      });
    }
    return this.mcpServerConfigPromise;
  }

  /** Inject MCP server config into a ChatService before connecting. */
  async configureMcpTools(service: ChatService): Promise<void> {
    const mcpServers = await this.getMcpServerConfig();
    console.log("[configureMcpTools] Setting", mcpServers.length, "MCP server(s) on ChatService");
    service.setMcpServers(mcpServers);
  }

  /** Cancel any in-flight prompt and clean up streaming UI. */
  cancelActivePrompt(): void {
    if (this.inFlightPrompt) {
      const prev = this.inFlightPrompt;
      this.inFlightPrompt = null;
      prev.chatService.cancel();
      // Use abortStreaming instead of endStreaming to discard the partial
      // batch cleanly. endStreaming tries to finalize partial card blocks
      // which can produce malformed cards that render as code previews.
      prev.targetUI.abortStreaming(prev.streamAnchor);
      prev.chatService.onUpdate = prev.previousHandler;
    }
  }

  /**
   * Start a new chat session scoped to a specific test case.
   * Creates a fresh ChatService with the test-specific system prompt.
   * @param testUI — bound UI for this test's context (writes to the correct segment list).
   */
  async startTestChatSession(test: TestCaseWithResult, testUI?: ChatSessionUI): Promise<void> {
    const ui = testUI ?? this.ui;
    this.activeTestUI = testUI ?? null;
    ui.clearMessages();

    // Show a connecting indicator while the agent session spins up.
    // We use appendStatus for instant visibility (no debounce delay).
    ui.appendStatus('🔌 Connecting to agent for your test…');

    this.testChatService = new ChatService();
    await this.configureMcpTools(this.testChatService);
    await this.testChatService.connect(buildTestSystemPrompt());

    // Clear the connecting status — the real stream takes over
    ui.clearMessages();

    const prompt = buildTestAnalysisPrompt(test);
    const policyContext = this.state.getPolicyContext();

    const streamAnchor = ui.startStreaming();

    streamAgentMessage(
      this.testChatService,
      {
        pushStreamChunk: (text) => ui.pushStreamChunk(text),
        noteToolCallStarted: () => ui.noteToolCallStarted(),
        noteToolActivity: (title) => ui.noteToolActivity(mapToolToActivityLabel(title)),
      },
      prompt,
      policyContext,
      { logPrefix: 'testSession' },
    ).then(() => {
      ui.endStreaming();
    }).catch((err) => {
      console.error('[testSession] stream failed:', err);
      ui.abortStreaming(streamAnchor);
      ui.appendStatus("Failed to analyze test. Try selecting it again.");
    });
  }

  /** Clear all test session caches and disconnect test services. */
  clearTestSessions(): void {
    for (const [, cached] of this.testSessionCache) {
      cached.chatService.disconnect();
    }
    this.testSessionCache.clear();
    this.testChatService = null;
    this.activeTestId = null;
    this.activeTestUI = null;
  }
}
