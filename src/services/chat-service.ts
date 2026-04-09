/**
 * Integration with Kiro CLI Agent Client Protocol (ACP) for conversational AI.
 * Handles policy-mode chat (policy Q&A, edits) and document summarization.
 *
 * This service is transport-agnostic: it programs against the AcpTransport
 * interface. In production the IpcAcpTransport delegates to the Electron
 * preload bridge; in tests the DirectAcpTransport talks to kiro-cli directly.
 */
import type { ChatMessage, ChatCard, SummarizedSection, AcpSessionUpdate } from "../types";
import type { AcpTransport } from "./acp-transport";
import { IpcAcpTransport } from "./acp-transport";
import { isAcpTransientError, withRetry } from "../utils/retry";
import { extractCards } from "../utils/card-parser";

/**
 * Streamed update from the ACP agent during a prompt turn.
 * @deprecated Use AcpSessionUpdate from src/types instead. Kept for backward compat.
 */
export type AcpUpdate = AcpSessionUpdate;

export interface ChatServiceConfig {
  /** Working directory for the ACP session (used for file context). */
  cwd?: string;
  /** ACP transport implementation. Defaults to IpcAcpTransport (Electron IPC). */
  transport?: AcpTransport;
  /** MCP server configurations to register with the ACP session. */
  mcpServers?: import("./acp-transport").McpServerConfig[];
}

export class ChatService {
  private config: ChatServiceConfig;
  private transport: AcpTransport;
  private connected = false;
  private sessionId: string | null = null;
  /** Stored so reconnections re-use the same system prompt. */
  private systemPrompt: string | undefined;
  /**
   * Optional test-specific context injected into every message.
   * Set when the ChatService is used for a test chat so the agent always
   * knows which test the conversation is about — even after reconnects
   * or session restores.
   */
  testContext: string | null = null;
  /** Whether the underlying ACP process has been started (shared across instances). */
  private static processStarted = false;
  /** Unsubscribe from transport updates (returned by onUpdate). */
  private unsubscribe?: () => void;

  /** Called for each streamed chunk during a prompt turn. */
  onUpdate?: (update: AcpUpdate) => void;

  /** Maximum number of automatic reconnection attempts for transient ACP errors. */
  private static readonly MAX_RECONNECT_ATTEMPTS = 2;

  constructor(config: ChatServiceConfig = {}) {
    this.config = config;
    this.transport = config.transport ?? new IpcAcpTransport();
  }

  /**
   * Set MCP server configurations before connecting.
   * Must be called before connect() — has no effect on an already-connected session.
   */
  setMcpServers(mcpServers: import("./acp-transport").McpServerConfig[]): void {
    this.config = { ...this.config, mcpServers };
  }

  /**
   * Start the Kiro CLI subprocess (if not already running) and establish an ACP session.
   * Must be called before sending messages.
   * @param systemPrompt Optional system prompt that configures agent behavior for the session.
   *                     Stored internally so reconnections preserve it.
   */
  async connect(systemPrompt?: string): Promise<void> {
    if (this.connected) return;

    // Remember the prompt so fallback reconnections in sendPolicyMessage
    // don't silently create a session without instructions.
    if (systemPrompt) {
      this.systemPrompt = systemPrompt;
    }

    // Start the ACP process only once (shared across all ChatService instances)
    if (!ChatService.processStarted) {
      await this.transport.start(this.config.cwd);
      ChatService.processStarted = true;
    }

    // Listen for streamed updates from the agent
    this.unsubscribe = this.transport.onUpdate((raw: unknown) => {
      const update = raw as AcpSessionUpdate;
      // Route updates to the correct ChatService instance by checking sessionId
      const updateSessionId = update.sessionId;
      if (updateSessionId && this.sessionId && updateSessionId !== this.sessionId) {
        return; // Not for this session
      }
      this.onUpdate?.(update);
    }) ?? undefined;

    console.log("[ChatService.connect] mcpServers:", this.config.mcpServers?.length ?? 0,
      this.config.mcpServers?.map(s => `${s.name}:${s.command} ${s.args.join(" ")}`));
    this.sessionId = await this.transport.createSession(
      this.config.cwd,
      this.systemPrompt,
      this.config.mcpServers,
    );
    console.log("[ChatService.connect] Session created:", this.sessionId);
    this.connected = true;
  }

  /**
   * Tear down the current session and re-establish a fresh connection.
   * Called automatically when a transient ACP error is detected.
   */
  private async reconnect(): Promise<void> {
    console.warn("[ChatService] Reconnecting ACP session…");

    // Emit a synthetic update so the UI can show a reconnection indicator
    this.onUpdate?.({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "\n\n*Reconnecting to the policy engine…*\n\n" },
    } as AcpUpdate);

    // Unsubscribe from stale update listener
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.connected = false;
    this.sessionId = null;

    // The subprocess may have died — reset the shared flag so start() runs again
    ChatService.processStarted = false;

    // Stop the old process (safe to call even if already dead)
    try { this.transport.stop(); } catch { /* Safe to ignore — transport may already be stopped or in a broken state */ }

    // Re-establish from scratch
    await this.connect(this.systemPrompt);
  }

  /**
   * Send a prompt, automatically reconnecting on transient ACP errors.
   * Retries up to MAX_RECONNECT_ATTEMPTS times with a delay between attempts.
   */
  private async sendPromptWithReconnect(prompt: string): Promise<{ stopReason: string }> {
    return withRetry(
      () => this.transport.sendPrompt(prompt, this.sessionId ?? undefined),
      {
        maxRetries: ChatService.MAX_RECONNECT_ATTEMPTS,
        baseDelayMs: 1000,
        isRetryable: isAcpTransientError,
        onRetry: async (attempt) => {
          console.warn(
            "[ChatService] Transient ACP error (attempt %d/%d) — reconnecting…",
            attempt,
            ChatService.MAX_RECONNECT_ATTEMPTS,
          );
          await this.reconnect();
        },
      },
    );
  }

  /**
   * Send a prompt and collect the streamed text response.
   * Installs a temporary onUpdate handler that accumulates agent_message_chunk
   * text, forwards all updates to the previous handler, and restores it in finally.
   */
  private async collectStreamedText(prompt: string): Promise<string> {
    if (!this.connected) await this.connect();

    let assembledText = "";
    const previousHandler = this.onUpdate;
    this.onUpdate = (update) => {
      if (update.sessionUpdate === "agent_message_chunk" && update.content?.text) {
        assembledText += update.content.text;
      }
      previousHandler?.(update);
    };

    try {
      await this.sendPromptWithReconnect(prompt);
    } finally {
      this.onUpdate = previousHandler;
    }

    return assembledText;
  }

  /**
   * Send a message in policy mode. The prompt includes policy context
   * so the ACP agent can reason about the policy.
   *
   * Returns the assembled assistant message once the turn completes.
   * Streamed chunks are emitted via onUpdate during processing.
   */
  async sendPolicyMessage(
    userMessage: string,
    policyContext?: Record<string, unknown>
  ): Promise<ChatMessage> {
    // Build the prompt with policy context embedded.
    // Includes behavioral rules so the agent stays on track in long conversations.
    const perMessageInstructions = [
      "[CRITICAL BEHAVIORAL RULES — FOLLOW THESE IN EVERY RESPONSE]",
      "You MUST use your policy workflow tools for all policy operations. NEVER tell the user to run commands. NEVER say you cannot do something. NEVER show CLI commands, raw JSON, ARNs, or code blocks. YOU are the interface.",
      "",
      "[APPROVAL WORKFLOW — READ CAREFULLY]",
      "Tools that require approval (add_rules, add_variables, update_variables, delete_rules, delete_variables) MUST NOT be called without an approval code.",
      "If you need to use one of these tools: (1) emit a proposal card, (2) STOP and wait for the user's next message, (3) look for [APPROVAL_CODE: <code>] in their message, (4) pass that exact code as the approvalCode parameter.",
      "NEVER call an approval-requiring tool in the same turn as emitting a proposal card. NEVER fabricate an approval code.",
      "If the user's message contains [APPROVAL_CODE: <code>], extract the code and immediately call the tool with it.",
      "EACH APPROVAL CODE IS SINGLE-USE. Once you pass a code to a tool, it is consumed and invalidated. You CANNOT reuse a code for a second tool call. If you need to call another approval-requiring tool, you MUST emit a new proposal card and wait for a fresh code.",
      "",
      "[RESPONSE FORMAT INSTRUCTIONS]",
      "You MUST render structured data using JSON card blocks, never as plain text, bullet points, or markdown.",
      'For each test case, emit: ```json\n{"type":"test","testId":"...","answer":"...","question":"...","expectedStatus":"...","actualStatus":"...","findingsSummary":"..."}\n```',
      'For each rule, emit: ```json\n{"type":"rule","ruleId":"...","expression":"...","naturalLanguage":"..."}\n```',
      'For suggested next actions, emit: ```json\n{"type":"next-steps","summary":"...","description":"...","prompt":"..."}\n```',
      'For policy changes requiring approval, emit: ```json\n{"type":"proposal","title":"...","description":"...","changes":[{"label":"...","before":"...","after":"..."}],"approvePrompt":"...","rejectPrompt":"..."}\n```',
      "When listing multiple items (tests, rules), emit one card per item. Never summarize them as bullet points.",
      "Do NOT emit any other JSON blocks that are not one of these card types. No freeform JSON summaries.",
      "[END INSTRUCTIONS]",
    ].join("\n");

    // When in a test chat, inject the test context so the agent always knows
    // which test the conversation is about — even if the session was restored
    // from cache or disk and has no prior conversation history.
    const testBlock = this.testContext
      ? `\n\n[ACTIVE TEST CONTEXT — This is the test the user is currently working on. All questions relate to this test unless stated otherwise.]\n${this.testContext}\n[END TEST CONTEXT]`
      : "";

    const contextPrefix = policyContext
      ? `${perMessageInstructions}${testBlock}\n\n[INTERNAL CONTEXT — DO NOT SHOW TO USER. Translate all data into plain language. Never display JSON, code blocks, or raw field names from this context.]\n${JSON.stringify(policyContext)}\n[END INTERNAL CONTEXT]\n\n`
      : `${perMessageInstructions}${testBlock}\n\n`;

    const fullPrompt = `${contextPrefix}${userMessage}`;

    let assembledText = await this.collectStreamedText(fullPrompt);

    // Try to extract cards from the response.
    // The agent may emit cards as ```json fenced blocks OR as <card> XML blocks.
    const { cards: extractedCards, text: cleanedText } = extractCards(assembledText);

    let card: ChatCard | undefined;
    if (extractedCards.length > 0) {
      assembledText = cleanedText;
      card = extractedCards[0]; // backward compat
    }

    return {
      id: crypto.randomUUID(),
      role: "assistant",
      content: assembledText,
      card,
      cards: extractedCards.length > 0 ? extractedCards : undefined,
      timestamp: Date.now(),
    };
  }

  /**
   * Send a message without policy behavioral instructions or card extraction.
   * The system prompt (set during connect()) is the sole behavioral guide.
   * Use for lightweight generation tasks (test suggestion, test generation from
   * selection) where policy-agent instructions would interfere.
   */
  async sendRawMessage(userMessage: string): Promise<ChatMessage> {
    const assembledText = await this.collectStreamedText(userMessage);

    return {
      id: crypto.randomUUID(),
      role: "assistant",
      content: assembledText,
      timestamp: Date.now(),
    };
  }

  /**
   * Summarize a document into structured sections with rule references.
   * Uses the ACP agent with a summarization-specific prompt.
   */
  async summarizeDocument(documentText: string): Promise<SummarizedSection[]> {
    const prompt = [
      "Summarize the following document into structured sections.",
      "Each section should have a title and a list of rules extracted from the text.",
      "Return ONLY a JSON array of sections in this format:",
      '```json\n[{"sectionTitle": "...", "rules": [{"naturalLanguage": "...", "sourceRef": {"sectionIndex": 0, "ruleIndex": 0, "lineStart": 1, "lineEnd": 5}}]}]\n```',
      "",
      "Document:",
      documentText,
    ].join("\n");

    const assembledText = await this.collectStreamedText(prompt);

    // Extract JSON from the response
    const jsonMatch = assembledText.match(/```json\s*\n([\s\S]*?)\n```/)
      ?? assembledText.match(/\[[\s\S]*\]/);

    if (!jsonMatch) {
      throw new Error("Failed to parse summarization response");
    }

    const raw = jsonMatch[1] ?? jsonMatch[0];
    return JSON.parse(raw) as SummarizedSection[];
  }

  /**
   * Cancel the current prompt turn.
   */
  cancel(): void {
    this.transport.cancel(this.sessionId ?? undefined);
  }

  /**
   * Disconnect this session. Does NOT stop the ACP subprocess
   * since other sessions may still be active.
   */
  disconnect(): void {
    if (!this.connected) return;
    // Unsubscribe from transport updates so this dead session doesn't intercept them
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    // We don't call transport.stop() here — that kills the shared subprocess.
    // Just mark this session as disconnected so connect() creates a new one.
    this.connected = false;
    this.sessionId = null;
  }

  /**
   * Stop the entire ACP subprocess. Only call when shutting down the app
   * or when no sessions should remain active.
   */
  stopProcess(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.transport.stop();
    this.connected = false;
    this.sessionId = null;
    ChatService.processStarted = false;
  }

  get isConnected(): boolean {
    return this.connected;
  }
}

// Card extraction utilities re-exported from src/utils/card-parser.ts
export { extractCards, stripCardBlocks, findPartialCardStart } from "../utils/card-parser";
