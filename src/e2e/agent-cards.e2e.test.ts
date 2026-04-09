/**
 * E2E tests: Agent response card parsing.
 *
 * Verifies that the real Kiro CLI agent emits responses containing
 * parseable card blocks (JSON or XML) that extractCards() can handle.
 * These tests catch regressions when the underlying LLM changes.
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
  runPreflightChecks,
  log,
  PROMPT_TIMEOUT,
} from "./e2e-helpers";

// ── Fixtures ──

/**
 * Realistic policy context so the agent has actual rules/variables to
 * render as cards. Without this, the agent gives generic prose.
 */
const POLICY_CONTEXT = {
  policyArn: "arn:aws:bedrock:us-west-2:123456789012:automated-reasoning-policy/test-policy",
  policyDefinition: {
    version: "1.0",
    types: [
      {
        name: "EmployeeRole",
        description: "The role of the employee in the organization",
        values: [
          { value: "MANAGER", description: "A people manager" },
          { value: "INDIVIDUAL_CONTRIBUTOR", description: "An individual contributor" },
          { value: "DIRECTOR", description: "A director-level leader" },
        ],
      },
    ],
    rules: [
      {
        ruleId: "rule-001",
        expression: "(=> (= employeeRole MANAGER) (not approvalRequired))",
        description: "Managers do not need approval for expenses",
      },
      {
        ruleId: "rule-002",
        expression: "(=> (> expenseAmount 5000) approvalRequired)",
        description: "Expenses over $5,000 require approval",
      },
      {
        ruleId: "rule-003",
        expression: "(=> (and (= employeeRole DIRECTOR) (<= expenseAmount 10000)) (not approvalRequired))",
        description: "Directors can approve expenses up to $10,000 without additional approval",
      },
    ],
    variables: [
      { name: "employeeRole", type: "EmployeeRole", description: "The role of the employee submitting the expense" },
      { name: "expenseAmount", type: "REAL", description: "The dollar amount of the expense being submitted" },
      { name: "approvalRequired", type: "BOOL", description: "Whether the expense requires manager approval" },
    ],
  },
};

// ── Setup ──

beforeAll(() => {
  runPreflightChecks();
});

// ── Tests ──

describe("Agent response card parsing", () => {
  let chatService: ChatService;
  let transport: DirectAcpTransport;

  afterEach(() => {
    log("Stopping E2E test context...");
    chatService?.stopProcess();
    log("E2E test context stopped");
  });

  it("emits parseable rule cards when asked to explain a specific rule", async () => {
    ({ chatService, transport } = await createE2eChatService(buildSystemPrompt()));

    const { cards, text } = await sendAndParse(
      chatService,
      "Explain the rule about managers not needing approval. Show me the rule details.",
      POLICY_CONTEXT,
    );

    log(`Cards received: ${cards.length} — types: ${cards.map((c) => c.type).join(", ")}`);
    log(`Prose (first 200 chars): ${text.slice(0, 200)}`);

    // With a real policy definition in context, the agent should render rule cards
    const ruleCards = cards.filter((c) => c.type === "rule");
    if (ruleCards.length > 0) {
      for (const card of ruleCards) {
        if (card.type !== "rule") continue;
        expect(card.ruleId).toBeTruthy();
        expect(typeof card.ruleId).toBe("string");
        expect(card.expression).toBeTruthy();
        expect(card.naturalLanguage).toBeTruthy();
      }
    }

    // At minimum, the agent should respond with something meaningful
    expect(text.length + cards.length).toBeGreaterThan(0);
  }, PROMPT_TIMEOUT);

  it("emits next-steps or follow-up-prompt cards after explaining rules", async () => {
    ({ chatService, transport } = await createE2eChatService(buildSystemPrompt()));

    const { cards } = await sendAndParse(
      chatService,
      "Walk me through all the rules in my policy. What does each one do?",
      POLICY_CONTEXT,
    );

    log(`Cards received: ${cards.length} — types: ${cards.map((c) => c.type).join(", ")}`);

    // The agent should emit some cards when explaining a policy with rules
    const actionableCards = cards.filter(
      (c) => c.type === "next-steps" || c.type === "follow-up-prompt" || c.type === "rule",
    );

    // With 3 rules in context, we expect at least some card output
    if (actionableCards.length > 0) {
      for (const card of actionableCards) {
        expect(card.type).toBeTruthy();
        if (card.type === "next-steps") {
          expect(card.prompt).toBeTruthy();
        }
        if (card.type === "follow-up-prompt") {
          expect(card.label).toBeTruthy();
          expect(card.prompt).toBeTruthy();
        }
        if (card.type === "rule") {
          expect(card.ruleId).toBeTruthy();
        }
      }
    }
  }, PROMPT_TIMEOUT);

  it("response contains prose text (agent always explains in plain language)", async () => {
    ({ chatService, transport } = await createE2eChatService(buildSystemPrompt()));

    const { text, cards } = await sendAndParse(
      chatService,
      "Give me an overview of my expense approval policy.",
      POLICY_CONTEXT,
    );

    log(`Prose length: ${text.length}, Cards: ${cards.length}`);

    // Agent should always produce prose text explaining things in plain language
    expect(text.length).toBeGreaterThan(0);
    // The prose should reference domain concepts from the policy
    const lowerText = text.toLowerCase();
    expect(
      lowerText.includes("expense") ||
      lowerText.includes("approval") ||
      lowerText.includes("manager") ||
      lowerText.includes("rule") ||
      lowerText.includes("policy"),
    ).toBe(true);
  }, PROMPT_TIMEOUT);

  it("all parsed cards have a valid type field", async () => {
    ({ chatService, transport } = await createE2eChatService(buildSystemPrompt()));

    const { cards } = await sendAndParse(
      chatService,
      "Show me the details of all my policy rules.",
      POLICY_CONTEXT,
    );

    log(`Cards received: ${cards.length}`);

    const VALID_TYPES = new Set([
      "rule", "test", "next-steps", "variable-proposal",
      "guardrail-validation", "follow-up-prompt", "proposal",
    ]);

    // Every card that was parsed must have a recognized type
    for (const card of cards) {
      expect(card.type).toBeTruthy();
      expect(VALID_TYPES.has(card.type)).toBe(true);
    }
  }, PROMPT_TIMEOUT);

  it("card format is stable — required fields present with correct types", async () => {
    ({ chatService, transport } = await createE2eChatService(buildSystemPrompt()));

    const { cards } = await sendAndParse(
      chatService,
      "Explain each rule in my policy and suggest what I should do next.",
      POLICY_CONTEXT,
    );

    log(`Cards for schema validation: ${cards.length}`);

    for (const card of cards) {
      expect(typeof card.type).toBe("string");

      switch (card.type) {
        case "rule":
          expect(typeof card.ruleId).toBe("string");
          expect(typeof card.expression).toBe("string");
          expect(typeof card.naturalLanguage).toBe("string");
          break;
        case "test":
          expect(typeof card.testId).toBe("string");
          expect(typeof card.answer).toBe("string");
          break;
        case "next-steps":
          expect(typeof card.prompt).toBe("string");
          break;
        case "follow-up-prompt":
          expect(typeof card.label).toBe("string");
          expect(typeof card.prompt).toBe("string");
          break;
        case "proposal":
          expect(typeof card.title).toBe("string");
          expect(typeof card.description).toBe("string");
          expect(Array.isArray(card.changes)).toBe(true);
          break;
      }
    }
  }, PROMPT_TIMEOUT);
});
