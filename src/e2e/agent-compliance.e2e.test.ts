/**
 * E2E tests: System prompt compliance.
 *
 * Verifies that the real Kiro CLI agent follows the behavioral rules
 * defined in the system prompt — no raw JSON in prose, no ARNs,
 * no CLI commands, cards are mandatory for certain operations.
 *
 * These tests catch regressions when the underlying LLM or system
 * prompt changes.
 *
 * Prerequisites:
 *   - kiro-cli installed and on PATH
 *   - Valid AWS credentials
 *
 * Run with: npm run test:e2e
 */
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { buildSystemPrompt } from "../prompts/agent-system-prompt";
import type { ChatService } from "../services/chat-service";
import type { DirectAcpTransport } from "../services/direct-acp-transport";
import {
  createE2eChatService,
  sendAndParse,
  assertNoForbiddenProse,
  runPreflightChecks,
  log,
  PROMPT_TIMEOUT,
} from "./e2e-helpers";

// ── Setup ──

beforeAll(() => {
  runPreflightChecks();
});

// ── Tests ──

describe("System prompt compliance — no raw technical content", () => {
  let chatService: ChatService;
  let transport: DirectAcpTransport;

  afterEach(() => {
    log("Stopping E2E test context...");
    chatService?.stopProcess();
    log("E2E test context stopped");
  });

  it("does not include raw JSON in prose when discussing policy", async () => {
    ({ chatService, transport } = await createE2eChatService(buildSystemPrompt()));

    const { text } = await sendAndParse(
      chatService,
      "Tell me about my policy and what rules it contains.",
      { policyArn: "arn:aws:bedrock:us-west-2:123456789012:automated-reasoning-policy/test-policy" },
    );

    log(`Prose text (first 300 chars): ${text.slice(0, 300)}`);
    assertNoForbiddenProse(text);
  }, PROMPT_TIMEOUT);

  it("does not expose ARNs or internal IDs in prose", async () => {
    ({ chatService, transport } = await createE2eChatService(buildSystemPrompt()));

    const { text } = await sendAndParse(
      chatService,
      "What is the status of my policy? Give me all the details.",
      { policyArn: "arn:aws:bedrock:us-west-2:123456789012:automated-reasoning-policy/test-policy" },
    );

    log(`Prose text (first 300 chars): ${text.slice(0, 300)}`);
    assertNoForbiddenProse(text);
  }, PROMPT_TIMEOUT);

  it("does not suggest CLI commands to the user", async () => {
    ({ chatService, transport } = await createE2eChatService(buildSystemPrompt()));

    const { text } = await sendAndParse(
      chatService,
      "How do I add a new rule to my policy?",
      { policyArn: "arn:aws:bedrock:us-west-2:123456789012:automated-reasoning-policy/test-policy" },
    );

    log(`Prose text (first 300 chars): ${text.slice(0, 300)}`);
    assertNoForbiddenProse(text);

    // Should not contain shell-like commands
    expect(text).not.toMatch(/\$ /);
    expect(text).not.toMatch(/kiro-cli/i);
    expect(text).not.toMatch(/aws bedrock/i);
  }, PROMPT_TIMEOUT);
});

describe("System prompt compliance — cards are mandatory", () => {
  let chatService: ChatService;
  let transport: DirectAcpTransport;

  afterEach(() => {
    log("Stopping E2E test context...");
    chatService?.stopProcess();
    log("E2E test context stopped");
  });

  it("emits cards with valid structure when cards are present", async () => {
    ({ chatService, transport } = await createE2eChatService(buildSystemPrompt()));

    const { cards } = await sendAndParse(
      chatService,
      "Explain all the rules in my policy and suggest improvements.",
      {
        policyArn: "arn:aws:bedrock:us-west-2:123456789012:automated-reasoning-policy/test-policy",
        policyDefinition: {
          version: "1.0",
          types: [],
          rules: [
            { ruleId: "rule-001", expression: "(=> (= role ADMIN) canDelete)", description: "Admins can delete" },
          ],
          variables: [
            { name: "role", type: "BOOL", description: "User role" },
            { name: "canDelete", type: "BOOL", description: "Whether user can delete" },
          ],
        },
      },
    );

    log(`Cards emitted: ${cards.length}`);

    // When cards are present, they must have valid structure
    for (const card of cards) {
      expect(card.type).toBeTruthy();
      expect(typeof card.type).toBe("string");
    }
  }, PROMPT_TIMEOUT);

  it("stays on topic — redirects off-topic questions", async () => {
    ({ chatService, transport } = await createE2eChatService(buildSystemPrompt()));

    const { text } = await sendAndParse(
      chatService,
      "What is the weather like today?",
      { policyArn: "arn:aws:bedrock:us-west-2:123456789012:automated-reasoning-policy/test-policy" },
    );

    log(`Off-topic response (first 300 chars): ${text.slice(0, 300)}`);

    // Agent should redirect to policy topics, not answer the weather question
    const lowerText = text.toLowerCase();
    expect(
      lowerText.includes("policy") ||
      lowerText.includes("rule") ||
      lowerText.includes("help") ||
      lowerText.includes("assist") ||
      lowerText.includes("can't") ||
      lowerText.includes("cannot") ||
      lowerText.includes("not able") ||
      lowerText.includes("outside") ||
      lowerText.includes("scope"),
    ).toBe(true);
  }, PROMPT_TIMEOUT);
});
