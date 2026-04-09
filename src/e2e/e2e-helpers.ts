/**
 * Shared helpers for Tier 3 end-to-end tests.
 *
 * These tests spawn a real Kiro CLI process via DirectAcpTransport
 * and verify that agent responses can be parsed correctly.
 *
 * Prerequisites:
 *   - kiro-cli must be installed and on PATH (or at ~/.local/bin/kiro-cli)
 *   - Valid AWS credentials available (for the ACP session)
 *
 * Run with:
 *   npm run test:e2e
 */
import { existsSync } from "fs";
import { execSync } from "child_process";
import { DirectAcpTransport } from "../services/direct-acp-transport";
import { ChatService } from "../services/chat-service";
import { extractCards } from "../utils/card-parser";
import { resolveKiroCliPath, canResolve } from "../utils/cli-resolve";
import type { ChatCard, AcpSessionUpdate } from "../types";

// ── Constants ──

export const CLI_PATH = resolveKiroCliPath();
export const CWD = process.cwd();

/** Per-test timeout for prompts that wait for agent responses. */
export const PROMPT_TIMEOUT = 120_000;

// ── Types ──

export interface E2eTestContext {
  chatService: ChatService;
  transport: DirectAcpTransport;
}

export interface ParsedAgentResponse {
  /** Prose text with card blocks removed. */
  text: string;
  /** Parsed card objects extracted from the response. */
  cards: ChatCard[];
  /** Raw streamed text chunks (for debugging). */
  rawChunks: string[];
  /** Tool calls observed during the turn. */
  toolCalls: ToolCallObservation[];
}

export interface ToolCallObservation {
  title: string;
  status: string;
  toolCallId: string;
  input?: unknown;
}

// ── Helpers ──

export function log(msg: string): void {
  console.error(`[e2e] ${msg}`);
}

/**
 * Run pre-flight checks for the Kiro CLI binary.
 * Call from beforeAll() in each test file.
 */
export function runPreflightChecks(): void {
  log(`CLI_PATH: ${CLI_PATH}`);
  log(`CWD: ${CWD}`);

  const onPath = canResolve(CLI_PATH);
  log(`Resolved CLI path: ${CLI_PATH} (reachable: ${onPath})`);

  if (!onPath && !existsSync(CLI_PATH)) {
    log("WARNING: kiro-cli not found. Tests will fail at spawn.");
  }

  if (existsSync(CLI_PATH)) {
    try {
      const version = execSync(`${CLI_PATH} --version 2>&1`, { timeout: 5000 })
        .toString()
        .trim();
      log(`kiro-cli version: ${version}`);
    } catch (err) {
      log(`kiro-cli --version failed: ${(err as Error).message}`);
    }
  }
}

/**
 * Create a connected ChatService with DirectAcpTransport for E2E tests.
 *
 * The caller MUST call `chatService.stopProcess()` in afterEach to
 * kill the kiro-cli subprocess. `disconnect()` alone is not sufficient.
 */
export async function createE2eChatService(
  systemPrompt?: string,
): Promise<E2eTestContext> {
  const transport = new DirectAcpTransport({
    cliPath: CLI_PATH,
    cwd: CWD,
    debug: true,
  });
  const chatService = new ChatService({ transport });
  await chatService.connect(systemPrompt);
  return { chatService, transport };
}

/**
 * Send a prompt and collect the full response text + parsed cards.
 *
 * Saves and restores the existing onUpdate handler so callers can
 * chain multiple sends without losing their own listeners.
 */
export async function sendAndParse(
  chatService: ChatService,
  prompt: string,
  policyContext?: Record<string, unknown>,
): Promise<ParsedAgentResponse> {
  const rawChunks: string[] = [];
  const toolCalls: ToolCallObservation[] = [];
  const previousHandler = chatService.onUpdate;

  chatService.onUpdate = (update: AcpSessionUpdate) => {
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.text) {
      rawChunks.push(update.content.text);
    }
    if (update.sessionUpdate === "tool_call") {
      toolCalls.push({
        title: update.title,
        status: update.status,
        toolCallId: update.toolCallId,
        input: update.input ?? update.arguments,
      });
    }
    previousHandler?.(update);
  };

  try {
    const response = await chatService.sendPolicyMessage(prompt, policyContext);
    const { cards, text } = extractCards(response.content);
    return { text, cards, rawChunks, toolCalls };
  } finally {
    chatService.onUpdate = previousHandler;
  }
}

// ── Assertion helpers ──

/** Regex patterns that should never appear in agent prose text. */
const FORBIDDEN_PROSE_PATTERNS = [
  /arn:aws:bedrock:[a-z0-9-]+:\d+:/i,           // AWS ARNs
  /\$ ?(kiro|aws|bedrock|python|node|npm) /,     // CLI commands
  /```(json|bash|sh|python|typescript)/,          // Code blocks
  /\{[\s\S]*"type"\s*:\s*"/,                      // Raw JSON objects
  /"policyArn"\s*:/,                               // Raw policy ARN fields
  /buildWorkflowId/,                               // Internal IDs in prose
];

/**
 * Assert that agent prose text contains no forbidden technical content.
 * Cards are excluded — only the cleaned text (after card extraction) is checked.
 */
export function assertNoForbiddenProse(text: string): void {
  for (const pattern of FORBIDDEN_PROSE_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(
        `Agent prose contains forbidden pattern ${pattern}: "${text.slice(0, 500)}"`,
      );
    }
  }
}
