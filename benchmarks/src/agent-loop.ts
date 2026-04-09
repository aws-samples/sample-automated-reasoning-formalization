/**
 * Agent repair loop — drives the agent through iterative policy repair.
 *
 * Mirrors the app's two-agent architecture:
 *   1. Test agent (test system prompt) — scoped to ONE failing test, diagnoses
 *      and fixes it, runs only that test to verify.
 *   2. Policy agent (policy system prompt) — runs the full test suite after
 *      each test-agent fix to check for regressions or broader impact.
 *
 * Each iteration picks the next failing test, opens a test-agent session,
 * lets it propose and apply a fix, then runs the full suite via the policy agent.
 */
import * as crypto from "crypto";
import { ChatService } from "../../src/services/chat-service";
import type { PolicyService } from "../../src/services/policy-service";
import { DirectAcpTransport } from "../../src/services/direct-acp-transport";
import { buildTestSystemPrompt } from "../../src/prompts/test-system-prompt";
import { buildTestAnalysisPrompt } from "../../src/utils/test-analysis";
import { writeApprovalCode } from "../../src/services/approval-code-store";
import { resolveKiroCliPath } from "../../src/utils/cli-resolve";
import type { AcpSessionUpdate, ProposalCard, TestCaseWithResult } from "../../src/types";
import { toAppDefinition } from "../../src/utils/policy-definition";
import {
  buildContextIndex,
  buildPolicyOutline,
  buildTaskContext,
  estimateContextSize,
  DEFAULT_COMPACT_THRESHOLD_BYTES,
} from "../../src/services/context-index";
import { parseMarkdownSections, subdivideLargeSections } from "../../src/utils/markdown-sections";
import type {
  RepairIteration,
  RepairSession,
  TestResultSnapshot,
  ToolCallObservation,
  BenchmarkFixture,
  BenchmarkPolicy,
} from "./types";

interface AgentLoopConfig {
  maxIterations: number;
  approvalCodeFilePath: string;
  mcpServerConfig: { name: string; command: string; args: string[]; env: Record<string, string> };
  log: (msg: string) => void;
  abortSignal: AbortSignal;
}

/**
 * Run the baseline test execution, then iterate: pick a failing test,
 * open a test-agent session to fix it, run the full suite to check.
 */
export async function runAgentLoop(
  policyService: PolicyService,
  policy: BenchmarkPolicy,
  fixture: BenchmarkFixture,
  config: AgentLoopConfig,
): Promise<RepairSession> {
  const { maxIterations, approvalCodeFilePath, mcpServerConfig, log, abortSignal } = config;
  const iterations: RepairIteration[] = [];
  const startTime = Date.now();

  // ── Baseline (iteration 0) ──
  log("Running baseline test execution…");
  const baselineStart = Date.now();
  const baselineSnapshots = await runAllTests(policyService, policy, fixture, log);
  const baselinePassing = baselineSnapshots.filter(r => r.passed).length;
  const baselineFailing = baselineSnapshots.filter(r => !r.passed).length;

  iterations.push({
    iteration: 0,
    prompt: "(baseline — no agent prompt)",
    agentResponseText: "",
    agentCards: [],
    toolCalls: [],
    proposalCards: [],
    conversationTrace: [],
    testResults: baselineSnapshots,
    passingTests: baselinePassing,
    failingTests: baselineFailing,
    latencyMs: Date.now() - baselineStart,
    timestamp: Date.now(),
    proposalEmitted: false,
    buildErrorOccurred: false,
    targetFixtureTestId: null,
  });

  log(`Baseline: ${baselinePassing}/${baselineSnapshots.length} passing`);

  if (baselineFailing === 0) {
    log("All tests pass at baseline — nothing to repair.");
    return buildSession(iterations, startTime);
  }

  // ── Repair iterations ──
  // Each iteration: pick a failing test → test-agent fixes it → run full suite
  for (let i = 1; i <= maxIterations; i++) {
    if (abortSignal.aborted) { log("Benchmark aborted."); break; }

    const prevResults = iterations[iterations.length - 1].testResults;
    const failing = prevResults.filter(r => !r.passed);
    if (failing.length === 0) { log("All tests passing — stopping early."); break; }

    // Pick the first failing test for this iteration
    const targetTest = failing[0];
    log(`\n── Iteration ${i}: fixing "${targetTest.fixtureTestId}" ──`);

    const iterStart = Date.now();
    const toolCalls: ToolCallObservation[] = [];
    let buildErrorOccurred = false;
    let agentResponseText = "";
    let agentCards: any[] = [];
    let proposalCards: ProposalCard[] = [];
    const approvedProposals: ProposalCard[] = [];
    const conversationTrace: import("./types").ConversationTurn[] = [];
    let prompt = "";

    // Create a fresh test-agent session for this test
    const testChatService = await createAgentSession(mcpServerConfig, buildTestSystemPrompt());
    try {
      // Build the test context (same shape as the app's test chat)
      const testCaseWithResult = await buildTestCaseWithResult(
        policyService, policy, targetTest,
      );

      // Determine if compact mode will be active (same logic as buildFullPolicyContext)
      const fixtureDef = toAppDefinition(policy.policyDefinition);
      const compactMode = process.env.ARCHITECT_CONTEXT_MODE === "compact"
        || estimateContextSize(fixtureDef, fixture.sourceDocumentText || null) > DEFAULT_COMPACT_THRESHOLD_BYTES;

      prompt = buildTestAnalysisPrompt(testCaseWithResult, compactMode);

      const policyContext = await buildFullPolicyContext(policyService, policy, fixture, log, targetTest);

      // Install tool-call observer
      installToolCallObserver(testChatService, toolCalls, log);

      // Step 1: Send the test analysis prompt
      // The test agent will diagnose the issue and offer follow-up-prompt cards
      // with fix strategies (not proposal cards yet).
      log(`Sending test analysis prompt (${prompt.length} chars, context: ${JSON.stringify(policyContext).length} chars)…`);
      const response = await testChatService.sendPolicyMessage(prompt, policyContext);
      agentCards = response.cards ?? [];
      agentResponseText = response.content;
      log(`Agent responded (${agentResponseText.length} chars, ${agentCards.length} cards).`);
      logCardTypes(agentCards, log);
      conversationTrace.push({
        turnIndex: conversationTrace.length, promptSent: prompt,
        agentResponse: agentResponseText, cards: [...agentCards], toolCalls: [...toolCalls],
      });

      // Step 2: The test agent may offer fix strategies as follow-up-prompt or
      // next-steps cards. Always pick the FIRST one — the agent's primary
      // recommendation. This mirrors a user clicking the suggested fix.
      // Regression-check cards are filtered out — the benchmark runs the full
      // suite separately after each iteration.
      const actionableCards = filterActionableCards(agentCards, log);
      proposalCards = agentCards.filter((c: any): c is ProposalCard => c.type === "proposal");

      if (actionableCards.length > 0 && proposalCards.length === 0) {
        const selectedFix = actionableCards[0] as any;
        const label = selectedFix.label ?? selectedFix.summary ?? "fix";
        log(`Selecting suggested fix (1 of ${actionableCards.length}): "${label}"`);
        log(`  Prompt: ${(selectedFix.prompt as string).slice(0, 200)}…`);
        const fixResponse = await testChatService.sendPolicyMessage(selectedFix.prompt, policyContext);
        const fixCards = fixResponse.cards ?? [];
        agentCards = [...agentCards, ...fixCards];
        agentResponseText += "\n\n" + fixResponse.content;
        log(`Agent responded to fix selection (${fixResponse.content.length} chars, ${fixCards.length} cards).`);
        logCardTypes(fixCards, log);
        conversationTrace.push({
          turnIndex: conversationTrace.length, promptSent: selectedFix.prompt,
          agentResponse: fixResponse.content, cards: [...fixCards], toolCalls: [...toolCalls],
        });

        // Now look for proposal cards in the fix response
        proposalCards = fixCards.filter((c: any): c is ProposalCard => c.type === "proposal");

        // If still no proposal, the agent may have emitted another round of
        // next-steps/follow-up cards. Try one more level deep.
        if (proposalCards.length === 0) {
          const secondActionable = filterActionableCards(fixCards, log);
          if (secondActionable.length > 0) {
            const secondFix = secondActionable[0] as any;
            const secondLabel = secondFix.label ?? secondFix.summary ?? "fix";
            log(`No proposal yet — selecting suggested second-level fix (1 of ${secondActionable.length}): "${secondLabel}"…`);
            const secondResponse = await testChatService.sendPolicyMessage(secondFix.prompt, policyContext);
            const secondCards = secondResponse.cards ?? [];
            agentCards = [...agentCards, ...secondCards];
            agentResponseText += "\n\n" + secondResponse.content;
            log(`Agent responded (${secondResponse.content.length} chars, ${secondCards.length} cards).`);
            logCardTypes(secondCards, log);
            proposalCards = secondCards.filter((c: any): c is ProposalCard => c.type === "proposal");
          }
        }
      }

      if (proposalCards.length === 0) {
        log("⚠ No proposal card emitted after conversation — no fix applied this iteration.");
      }

      // Step 3: Drive the conversation until the agent completes its fix.
      // The agent may need multiple approval codes (e.g., batching variables
      // in groups of 10, then adding rules). We keep the conversation going
      // until the agent stops asking for approvals.
      const MAX_CONVERSATION_TURNS = 10;
      for (let turn = 0; turn < MAX_CONVERSATION_TURNS; turn++) {
        if (abortSignal.aborted) break;

        // Check current cards for proposals
        const currentProposals = proposalCards.length > 0 ? proposalCards : [];
        if (currentProposals.length === 0 && turn > 0) {
          // No more proposals — agent is done or needs a nudge
          break;
        }
        if (currentProposals.length === 0) break;

        const proposal = currentProposals[0];
        proposalCards = currentProposals.slice(1); // consume it
        approvedProposals.push(proposal); // track for judge evaluation

        log(`Proposal: "${proposal.title}" — auto-approving… (turn ${turn + 1})`);
        log(`  Changes: ${JSON.stringify(proposal.changes).slice(0, 500)}`);
        const code = crypto.randomUUID();
        writeApprovalCode(approvalCodeFilePath, code);

        const approvePrompt = `${proposal.approvePrompt} [APPROVAL_CODE: ${code}]`;
        const approveResponse = await testChatService.sendPolicyMessage(approvePrompt, policyContext);
        const approveCards = approveResponse.cards ?? [];

        log(`  Approval response (${approveResponse.content.length} chars):`);
        log(`  ${approveResponse.content.slice(0, 500)}`);
        logCardTypes(approveCards, log);
        conversationTrace.push({
          turnIndex: conversationTrace.length, promptSent: approvePrompt,
          agentResponse: approveResponse.content, cards: [...approveCards], toolCalls: [...toolCalls],
        });

        agentCards = [...agentCards, ...approveCards];
        agentResponseText += "\n\n" + approveResponse.content;

        const approveText = approveResponse.content.toLowerCase();
        if (approveText.includes("build error") || approveText.includes("error")) {
          // Check if it's an approval code error — provide a fresh one
          if (approveText.includes("approval code") || approveText.includes("consumed") || approveText.includes("invalid code")) {
            log("  ⚠ Approval code issue — agent may need a fresh code. Continuing conversation…");
          } else {
            buildErrorOccurred = true;
            log("  ⚠ Build error detected.");
          }
        }

        // Check if the agent emitted new proposals (needs another approval)
        const newProposals = approveCards.filter((c: any): c is ProposalCard => c.type === "proposal");
        if (newProposals.length > 0) {
          proposalCards = newProposals;
          continue; // loop back to approve the next proposal
        }

        // No more proposals — iteration complete.
        // Do NOT follow actionable cards after approval. The agent may suggest
        // moving on to another failing test, but each iteration must target
        // exactly one test. Close the iteration, measure test status, and let
        // the next iteration pick the next failing test.
        const skippedActionable = filterActionableCards(approveCards, log);
        if (skippedActionable.length > 0) {
          log(`  ⏭ Skipped ${skippedActionable.length} post-approval actionable card(s) — iteration boundary enforced.`);
        }
        break;
      }
    } finally {
      testChatService.stopProcess();
    }

    // Run the full test suite to see the impact of the fix
    if (abortSignal.aborted) break;
    log("Running full test suite…");
    const snapshots = await runAllTests(policyService, policy, fixture, log);
    const passing = snapshots.filter(r => r.passed).length;
    const stillFailing = snapshots.filter(r => !r.passed).length;
    log(`Results: ${passing}/${snapshots.length} passing.`);

    // Log tool call summary for this iteration
    if (toolCalls.length > 0) {
      const toolSummary = new Map<string, number>();
      for (const tc of toolCalls) {
        const name = tc.title || "unknown";
        toolSummary.set(name, (toolSummary.get(name) ?? 0) + 1);
      }
      const summary = [...toolSummary.entries()].map(([k, v]) => `${k} ×${v}`).join(", ");
      log(`Tool calls: ${summary}`);
    } else {
      log("Tool calls: none");
    }

    iterations.push({
      iteration: i,
      prompt,
      agentResponseText,
      agentCards,
      toolCalls,
      proposalCards: approvedProposals,
      conversationTrace,
      testResults: snapshots,
      passingTests: passing,
      failingTests: stillFailing,
      latencyMs: Date.now() - iterStart,
      timestamp: Date.now(),
      proposalEmitted: approvedProposals.length > 0,
      buildErrorOccurred,
      targetFixtureTestId: targetTest.fixtureTestId,
    });

    if (stillFailing === 0) { log("All tests passing — converged!"); break; }
  }

  return buildSession(iterations, startTime);
}
// ── Regression-check card filtering ──
// The test agent sometimes suggests "Run all tests to check for regressions"
// as a follow-up card. The benchmark already runs the full suite after each
// iteration (runAllTests at the end of each loop), so following that card
// would waste an entire agent conversation turn. Filter these out.

const REGRESSION_CHECK_PATTERNS = [
  /\brun\s+all\s+tests?\b/i,
  /\bfull\s+(test\s+)?suite\b/i,
  /\bcheck\s+(for\s+)?regressions?\b/i,
  /\bregression\s+(check|test|run)\b/i,
  /\brun\s+remaining\s+tests?\b/i,
  /\bexecute.*all.*test/i,
];

function isRegressionCheckCard(card: { label?: string; summary?: string; prompt?: string }): boolean {
  const fields = [card.label, card.summary, card.prompt].filter(Boolean) as string[];
  return fields.some(text => REGRESSION_CHECK_PATTERNS.some(p => p.test(text)));
}

/**
 * Filter actionable cards, removing any that suggest running all tests for
 * regressions. Logs skipped cards for visibility.
 */
function filterActionableCards(
  cards: any[],
  log: (msg: string) => void,
): any[] {
  const actionable = cards.filter(
    (c: any) => (c.type === "follow-up-prompt" || c.type === "next-steps") && c.prompt,
  );
  const regressionCards = actionable.filter(isRegressionCheckCard);
  if (regressionCards.length > 0) {
    log(`  ⏭ Skipped ${regressionCards.length} regression-check card(s): ${regressionCards.map((c: any) => c.label ?? c.summary ?? "(no label)").join(", ")}`);
  }
  return actionable.filter(c => !isRegressionCheckCard(c));
}

// ── Helpers ──

async function createAgentSession(
  mcpServerConfig: AgentLoopConfig["mcpServerConfig"],
  systemPrompt: string,
): Promise<ChatService> {
  const transport = new DirectAcpTransport({
    cliPath: resolveKiroCliPath(),
    cwd: process.cwd(),
    debug: false,
  });
  const chatService = new ChatService({ transport });
  chatService.setMcpServers([mcpServerConfig]);
  await chatService.connect(systemPrompt);
  return chatService;
}

function installToolCallObserver(
  chatService: ChatService,
  toolCalls: ToolCallObservation[],
  log: (msg: string) => void,
): void {
  const previousHandler = chatService.onUpdate;
  // IMPORTANT: sendPolicyMessage internally swaps onUpdate to collect chunks.
  // Our swap wraps the entire call. This works because calls are sequential.
  chatService.onUpdate = (update: AcpSessionUpdate) => {
    if (update.sessionUpdate === "tool_call") {
      const tc = update as import("../../src/types").AcpToolCall;
      const rawInput = tc.input ?? tc.arguments ?? (update as any).input ?? (update as any).arguments;
      const inputPreview = rawInput ? JSON.stringify(rawInput).slice(0, 500) : "(none)";
      log(`  🔧 tool_call: ${tc.title} [${tc.status}] id=${tc.toolCallId}`);
      log(`     input: ${inputPreview}`);
      toolCalls.push({
        title: tc.title,
        status: tc.status,
        toolCallId: tc.toolCallId,
        input: rawInput,
      });

      // Detect redundant full-suite test runs
      if (tc.title === "execute_tests" && rawInput) {
        const input = rawInput as { testCaseIds?: string[] };
        if (input.testCaseIds && input.testCaseIds.length > 1) {
          log(`  ⚠ Agent called execute_tests with ${input.testCaseIds.length} test IDs (expected 1). Redundant — benchmark runs full suite separately.`);
        }
      }
    }
    if (update.sessionUpdate === "tool_result") {
      const tr = update as import("../../src/types").AcpToolResult;
      const resultPreview = tr.content ? JSON.stringify(tr.content).slice(0, 1000) : "(none)";
      log(`  ✅ tool_result: id=${tr.toolCallId} status=${tr.status ?? "ok"}`);
      log(`     result: ${resultPreview}`);
      const match = toolCalls.find(tc => tc.toolCallId === tr.toolCallId);
      if (match) {
        match.result = tr.content;
        match.resultStatus = tr.status;
      }
    }
    previousHandler?.(update);
  };
}

/**
 * Build the policy context exactly as the app does in buildPolicyContext().
 * Re-exports the definition each time to reflect any changes the agent made.
 *
 * Automatically selects compact mode when the estimated context size
 * exceeds the threshold, or when forced via ARCHITECT_CONTEXT_MODE=compact.
 */
async function buildFullPolicyContext(
  policyService: PolicyService,
  policy: BenchmarkPolicy,
  fixture: BenchmarkFixture,
  log?: (msg: string) => void,
  targetTest?: TestResultSnapshot,
): Promise<Record<string, unknown>> {
  // Re-export the current definition (agent may have modified it via tools)
  let policyDefinition: unknown = policy.policyDefinition;
  try {
    policyDefinition = await policyService.exportPolicyDefinition(policy.policyArn);
    const def = policyDefinition as any;
    log?.(`  Policy context: ${def?.rules?.length ?? 0} rules, ${def?.variables?.length ?? 0} variables`);
  } catch (err) {
    log?.(`  Warning: exportPolicyDefinition failed, using cached: ${(err as Error).message}`);
  }

  // Fetch current test cases (the app includes these in context)
  let testCases: unknown[] | undefined;
  try {
    const tcs = await policyService.listTestCases(policy.policyArn);
    if (tcs.length > 0) testCases = tcs;
    log?.(`  Policy context: ${tcs.length} test cases`);
  } catch {
    // Non-critical — agent can work without test case list
  }

  const def = toAppDefinition(policyDefinition as import("@aws-sdk/client-bedrock").AutomatedReasoningPolicyDefinition);
  const docText = fixture.sourceDocumentText || null;

  // Determine context mode
  const forceCompact = process.env.ARCHITECT_CONTEXT_MODE === "compact";
  const estimatedSize = estimateContextSize(def, docText);
  const useCompact = forceCompact || estimatedSize > DEFAULT_COMPACT_THRESHOLD_BYTES;

  log?.(`  Context size estimate: ${estimatedSize} bytes, mode: ${useCompact ? "compact" : "full"}`);

  if (useCompact) {
    const sections = docText
      ? subdivideLargeSections(parseMarkdownSections(docText))
      : [];

    // Build fidelity report if available
    let fidelityReport = null;
    try {
      const builds = await policyService.listBuilds(policy.policyArn);
      for (const build of builds) {
        if (build.status === "COMPLETED") {
          const asset = await policyService.getBuildAssets(policy.policyArn, build.buildWorkflowId, "FIDELITY_REPORT");
          if (asset) {
            const { parseFidelityAsset } = await import("../../src/utils/fidelity");
            fidelityReport = parseFidelityAsset(asset);
            break;
          }
        }
      }
    } catch {
      // Non-critical — compact mode works without fidelity
    }

    const index = buildContextIndex(def, docText, sections, fidelityReport, []);
    const outline = buildPolicyOutline(index, policy.policyArn, []);

    // Build task context if we have a target test
    let taskContext = null;
    if (targetTest) {
      const testCaseWithResult = {
        testCase: {
          testCaseId: targetTest.testCaseId,
          guardContent: targetTest.guardContent,
          queryContent: targetTest.queryContent,
          expectedAggregatedFindingsResult: targetTest.expectedResult,
        },
        aggregatedTestFindingsResult: targetTest.actualResult,
        testFindings: targetTest.findings,
      } as unknown as TestCaseWithResult;
      taskContext = buildTaskContext(index, testCaseWithResult);
    }

    const ctx = {
      ...outline,
      ...(taskContext && { taskContext }),
      ...(testCases && { testCases }),
    };

    log?.(`  Context keys: ${Object.keys(ctx).join(", ")}`);
    return ctx;
  }

  // Full mode (existing behavior)
  const ctx = {
    policyArn: policy.policyArn,
    policyDefinition,
    ...(fixture.sourceDocumentText && { sourceDocumentText: fixture.sourceDocumentText }),
    ...(testCases && { testCases }),
  };

  log?.(`  Context keys: ${Object.keys(ctx).join(", ")}`);
  return ctx;
}

async function buildTestCaseWithResult(
  policyService: PolicyService,
  policy: BenchmarkPolicy,
  snapshot: TestResultSnapshot,
): Promise<TestCaseWithResult> {
  const tc = await policyService.getTestCase(policy.policyArn, snapshot.testCaseId);
  return {
    testCase: tc,
    aggregatedTestFindingsResult: snapshot.actualResult as any,
    testFindings: snapshot.findings as any,
  };
}

async function runAllTests(
  policyService: PolicyService,
  policy: BenchmarkPolicy,
  fixture: BenchmarkFixture,
  log: (msg: string) => void,
): Promise<TestResultSnapshot[]> {
  const builds = await policyService.listBuilds(policy.policyArn);
  const latestBuild = policyService.findLatestPolicyBuild(builds);
  if (!latestBuild) {
    throw new Error("No completed build found. Cannot run tests.");
  }

  const snapshots: TestResultSnapshot[] = [];
  for (const tcId of policy.testCaseIds) {
    let fixtureTestId = "unknown";
    for (const [fid, apiId] of policy.testIdMap.entries()) {
      if (apiId === tcId) { fixtureTestId = fid; break; }
    }

    try {
      const result = await policyService.executeTestCase(
        policy.policyArn, latestBuild.buildWorkflowId, tcId,
      );
      const actual = result.aggregatedTestFindingsResult ?? "UNKNOWN";
      const expected = result.testCase?.expectedAggregatedFindingsResult ?? "UNKNOWN";
      snapshots.push({
        testCaseId: tcId,
        fixtureTestId,
        guardContent: result.testCase?.guardContent ?? "",
        queryContent: result.testCase?.queryContent ?? "",
        expectedResult: expected as string,
        actualResult: actual as string,
        passed: actual === expected,
        findings: (result.testFindings ?? []) as unknown[],
      });
      log(`  ${fixtureTestId}: ${actual === expected ? "PASS" : "FAIL"} (expected ${expected}, got ${actual})`);
    } catch (err) {
      log(`  ${fixtureTestId}: ERROR — ${(err as Error).message}`);
      const fixtureTest = fixture.tests.find(t => t.id === fixtureTestId);
      snapshots.push({
        testCaseId: tcId, fixtureTestId,
        guardContent: fixtureTest?.guardContent ?? "",
        queryContent: fixtureTest?.queryContent ?? "",
        expectedResult: fixtureTest?.expectedResult ?? "UNKNOWN",
        actualResult: "ERROR", passed: false,
        findings: [{ type: "ERROR", description: (err as Error).message }],
      });
    }
  }
  return snapshots;
}

function logCardTypes(cards: any[], log: (msg: string) => void): void {
  const types = new Map<string, number>();
  for (const c of cards) {
    const t = c.type ?? "unknown";
    types.set(t, (types.get(t) ?? 0) + 1);
  }
  const summary = [...types.entries()].map(([k, v]) => `${k} ×${v}`).join(", ");
  log(`  Cards: ${summary || "none"}`);
}

function buildSession(iterations: RepairIteration[], startTime: number): RepairSession {
  const last = iterations[iterations.length - 1];
  return {
    iterations,
    totalLatencyMs: Date.now() - startTime,
    finalPassCount: last.passingTests,
    finalFailCount: last.failingTests,
    totalTests: last.testResults.length,
    converged: last.failingTests === 0,
  };
}
