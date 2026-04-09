/**
 * Shared types for the agent benchmark system.
 */
import type { ChatCard, ProposalCard } from "../../src/types";

// ── Fixture types ──

export interface BenchmarkTestCase {
  id: string;
  guardContent: string;
  queryContent: string;
  expectedResult: string;
  targetDeficiency: string;
  notes: string;
}

export interface BenchmarkFixture {
  policyDefinition: Record<string, unknown>;
  sourceDocumentText: string;
  tests: BenchmarkTestCase[];
}

// ── Harness types ──

export interface BenchmarkPolicy {
  policyArn: string;
  testCaseIds: string[];
  /** Map from fixture test id → API test case id. */
  testIdMap: Map<string, string>;
  policyDefinition: Record<string, unknown>;
  cleanup: () => Promise<void>;
}

// ── Agent loop types ──

export interface ToolCallObservation {
  title: string;
  status: string;
  toolCallId: string;
  input?: unknown;
  result?: unknown;
  resultStatus?: string;
}

export interface TestResultSnapshot {
  testCaseId: string;
  fixtureTestId: string;
  guardContent: string;
  queryContent: string;
  expectedResult: string;
  actualResult: string;
  passed: boolean;
  findings: unknown[];
}

export interface ConversationTurn {
  /** Which turn within this iteration (0 = initial diagnosis, 1 = fix selection, 2 = approval, etc.) */
  turnIndex: number;
  /** What was sent to the agent */
  promptSent: string;
  /** What the agent responded with (prose, cards stripped) */
  agentResponse: string;
  /** Cards emitted in this turn */
  cards: ChatCard[];
  /** Tool calls observed during this turn */
  toolCalls: ToolCallObservation[];
}

export interface RepairIteration {
  iteration: number;
  prompt: string;
  agentResponseText: string;
  agentCards: ChatCard[];
  toolCalls: ToolCallObservation[];
  proposalCards: ProposalCard[];
  /** Full conversation trace — each turn in the multi-step conversation */
  conversationTrace: ConversationTurn[];
  testResults: TestResultSnapshot[];
  passingTests: number;
  failingTests: number;
  latencyMs: number;
  timestamp: number;
  proposalEmitted: boolean;
  buildErrorOccurred: boolean;
  /** Which fixture test this iteration targeted (null for baseline) */
  targetFixtureTestId: string | null;
}

export interface RepairSession {
  iterations: RepairIteration[];
  totalLatencyMs: number;
  finalPassCount: number;
  finalFailCount: number;
  totalTests: number;
  converged: boolean;
}

// ── Evaluation types ──

export interface DeterministicEvaluation {
  allTestsPassed: boolean;
  iterationsToConverge: number;
  perTestConvergence: { testCaseId: string; fixtureTestId: string; firstPassedAtIteration: number | null }[];
  totalLatencyMs: number;
  perIterationLatencyMs: number[];
  totalToolCalls: number;
  totalBuildErrors: number;
  noOpIterations: number;
}

export interface ChangeAssessment {
  changeDescription: string;
  iteration: number;
  generalizability: "generalizable" | "likely_overfitting" | "unclear";
  paraphraseRobustness: "robust" | "fragile" | "unknown";
  rootCauseAddressed: boolean;
  reasoning: string;
}

export interface JudgeEvaluation {
  changes: ChangeAssessment[];
  overallScore: number;
  summary: string;
}

// ── Report types ──

export interface BenchmarkReport {
  runId: string;
  startTime: string;
  endTime: string;
  fixture: string;
  config: BenchmarkConfig;
  environment: { kiroCliVersion: string; nodeVersion: string; platform: string };
  ephemeralPolicy: { policyArn: string; createdAt: string; deletedAt: string };
  timing: { setupMs: number; baselineMs: number; agentLoopMs: number; judgeEvaluationMs: number; teardownMs: number; totalMs: number };
  session: RepairSession;
  deterministicEval: DeterministicEvaluation;
  judgeEval: JudgeEvaluation | null;
}

export interface BenchmarkConfig {
  maxIterations: number;
  perTurnTimeoutMs: number;
  globalTimeoutMs: number;
  skipJudge: boolean;
  region: string;
}
