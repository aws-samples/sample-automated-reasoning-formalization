# Agent Benchmark Testing Design

## Goal

Detect prompt regressions before they ship. When a developer changes `agent-system-prompt.ts` or `test-system-prompt.ts`, the benchmark suite creates a real Automated Reasoning policy from a fixture file, seeds it with test cases that have known failures, asks the agent to repair them through the normal conversational workflow, and produces an HTML report with deterministic and qualitative evaluations.

## Architecture Overview

```
benchmarks/
├── fixtures/
│   ├── expense-policy-definition.json  # Policy definition with 4 intentional deficiencies
│   ├── expense-policy-document.md      # Source document (Acme Corp expense approval policy)
│   └── expense-policy-tests.json       # 6 test cases targeting specific deficiencies
├── src/
│   ├── benchmark-runner.ts             # Orchestrates the full benchmark lifecycle
│   ├── policy-harness.ts              # Creates/seeds/tears down ephemeral policies
│   ├── agent-loop.ts                  # Drives the agent repair conversation
│   ├── evaluation.ts                  # Deterministic + LLM-as-judge scoring
│   └── report-generator.ts           # Produces the HTML report
├── reports/                           # Generated HTML reports (gitignored)
├── tsconfig.json                      # Extends root tsconfig for benchmarks/
└── README.md                          # How to run benchmarks
```

## Lifecycle

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. SETUP                                                            │
│    a. PolicyService.createPolicy("benchmark-<timestamp>")           │
│    b. PolicyService.updatePolicy(policyArn, fixtureDefinition)      │
│    c. PolicyService.startBuild(policyArn, "REFINE_POLICY",          │
│         { policyDefinition: fixtureDefinition })                    │
│    d. PolicyService.pollBuild(policyArn, buildWorkflowId)           │
│    e. PolicyService.createTestCase(...) × N                         │
├─────────────────────────────────────────────────────────────────────┤
│ 2. BASELINE                                                         │
│    PolicyWorkflowService.executeTests(policyArn, allTestCaseIds)    │
│    Record: which tests pass/fail, findings for each                 │
├─────────────────────────────────────────────────────────────────────┤
│ 3. AGENT REPAIR LOOP (max N iterations)                             │
│    For each iteration:                                              │
│      a. Build prompt with failing tests + policy context            │
│         (include fidelity report data for root-cause signal)        │
│      b. sendPolicyMessage → blocks until agent turn completes       │
│      c. Parse response for proposal cards                           │
│      d. If proposal card found:                                     │
│         i.  writeApprovalCode(tempFilePath, code)                   │
│         ii. sendPolicyMessage(approvePrompt + [APPROVAL_CODE])      │
│             → blocks through tool execution + build (3-5 min)       │
│      e. If no proposal card: log as no-op, retry with directive     │
│      f. Run full test suite via executeTests                        │
│      g. Record: pass/fail per test, tool calls, latency, cards      │
│      h. If all tests pass → stop. Otherwise → next iteration.       │
├─────────────────────────────────────────────────────────────────────┤
│ 4. LLM-AS-JUDGE EVALUATION                                         │
│    For each change the agent made:                                  │
│      - Was the fix generalizable or overfitting to the test text?   │
│      - Evaluate against 2-3 paraphrased test inputs                 │
│      - Did the agent address the root cause or just the symptom?    │
├─────────────────────────────────────────────────────────────────────┤
│ 5. TEARDOWN (in finally block — always runs)                        │
│    a. chatService.stopProcess() — kill kiro-cli subprocess          │
│    b. PolicyService.manageBuildSlot(policyArn) — clean up builds    │
│    c. PolicyService.deletePolicy(policyArn)                         │
│    d. Remove temp approval code file                                │
├─────────────────────────────────────────────────────────────────────┤
│ 6. REPORT                                                           │
│    Generate HTML with charts and summary tables                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Component Design

### 1. Policy Harness (`policy-harness.ts`)

Manages the ephemeral policy lifecycle. Uses `PolicyService` directly (no agent involvement).

```typescript
interface BenchmarkPolicy {
  policyArn: string;
  testCaseIds: string[];
  /** Exported definition after the initial build completes. */
  policyDefinition: PolicyDefinition;
  cleanup: () => Promise<void>;
}

async function createBenchmarkPolicy(
  policyService: PolicyService,
  fixture: BenchmarkFixture,
): Promise<BenchmarkPolicy>
```

Steps:
1. `createPolicy("benchmark-<timestamp>")` → policyArn
2. `updatePolicy(policyArn, fixture.policyDefinition)` → seeds rules/variables/types into the DRAFT
3. `startBuild(policyArn, "REFINE_POLICY", { policyDefinition: fixture.policyDefinition })` → triggers the actual build (critical: `updatePolicy` alone does NOT trigger a build, and `executeTests` requires a completed build to exist)
4. `pollBuild(policyArn, buildWorkflowId)` → wait for build completion
5. `createTestCase(...)` for each test in the fixture
6. `exportPolicyDefinition(policyArn)` → get the built definition for agent context
7. Return `{ policyArn, testCaseIds, policyDefinition, cleanup }`

The `cleanup` function:
1. `manageBuildSlot(policyArn)` — delete active builds (required before policy deletion)
2. `deletePolicy(policyArn)` — remove the ephemeral policy

The fixture's policy definition intentionally contains 4 isolated deficiencies:
- D1: Wrong implication direction (reversed conditional)
- D2: Wrong threshold constant (1000 instead of 5000)
- D3: Missing variable (`isInternational` omitted)
- D4: Ambiguous variable description (vague one-liner)

Each deficiency is independent and produces a specific, predictable test failure mode. See the Fixture Design section for details.

### 2. Benchmark Context (`benchmark-runner.ts`)

A single dependency injection interface passed to all modules:

```typescript
interface BenchmarkDeps {
  policyService: PolicyService;
  workflowService: PolicyWorkflowService;
  chatService: ChatService;
  approvalCodeFilePath: string;
  mcpServerPath: string;
  maxIterations: number;
  logger: (msg: string) => void;
  abortSignal: AbortSignal;
}
```

The runner:
1. Creates a temp file for approval codes: `path.join(os.tmpdir(), 'benchmark-approval-<timestamp>.json')`
2. Resolves the MCP server path (same as `ChatSessionManager.getMcpServerConfig()`)
3. Creates `ChatService` with `DirectAcpTransport`
4. Calls `chatService.setMcpServers(...)` BEFORE `chatService.connect()` (ordering is critical — MCP servers are passed to `createSession` during connect)
5. Registers `process.on('SIGINT', cleanup)` for crash safety
6. Wraps the entire lifecycle in try/finally for guaranteed teardown

MCP server configuration:
```typescript
chatService.setMcpServers([{
  name: "architect-policy-tools",
  command: "node",
  args: [mcpServerPath],
  env: {
    AWS_REGION: process.env.AWS_REGION ?? "us-west-2",
    APPROVAL_CODE_FILE: approvalCodeFilePath,
  },
}]);
```

### 3. Agent Loop (`agent-loop.ts`)

Drives the repair conversation using `DirectAcpTransport` + `ChatService`, reusing the `sendAndParse` pattern from `src/e2e/e2e-helpers.ts`.

```typescript
interface RepairIteration {
  iteration: number;
  prompt: string;
  agentResponse: ParsedAgentResponse;
  toolCalls: ToolCallObservation[];
  proposalCards: ProposalCard[];
  testResults: TestResult[];
  passingTests: number;
  failingTests: number;
  /** Wall-clock time for this iteration (agent + build + test execution). */
  latencyMs: number;
  timestamp: number;
  /** Whether the agent proposed a fix this iteration. */
  proposalEmitted: boolean;
  /** Whether a build error occurred during tool execution. */
  buildErrorOccurred: boolean;
}

interface RepairSession {
  iterations: RepairIteration[];
  totalLatencyMs: number;
  finalPassCount: number;
  finalFailCount: number;
  converged: boolean;
}
```

#### Key async flow: `sendPolicyMessage` blocks through tool execution

When the benchmark sends the approval prompt, `sendPolicyMessage` does NOT return until the agent's full turn completes — including any MCP tool execution. The MCP tool call triggers `PolicyWorkflowService.executeRefinePolicyWorkflow` inside the MCP server subprocess, which internally polls the build to completion (3-5 minutes). Only after the tool returns its result does the agent produce its final text response, and only then does `sendPolicyMessage` resolve.

This means the benchmark does NOT need a separate build-polling step. The per-turn timeout must be generous enough to accommodate build time: **10 minutes** (vs. the 120-second `PROMPT_TIMEOUT` used in e2e tests).

#### Approval code flow

The approval code file is the cross-process communication channel between the benchmark (which writes codes) and the MCP server subprocess (which reads and consumes them).

Ordering is critical:
1. Parse proposal card from agent response → extract `approvePrompt`
2. Generate UUID approval code
3. `writeApprovalCode(approvalCodeFilePath, code)` — write to file FIRST
4. Send `${approvePrompt} [APPROVAL_CODE: ${code}]` via `sendPolicyMessage`

The MCP server subprocess reads the file when the agent calls the tool with the code. Since the file write happens before the prompt is sent, there's no race condition.

#### Handling edge cases

- **No proposal card emitted**: The agent may explain the problem without proposing a fix, ask a clarifying question, or emit `follow-up-prompt` / `next-steps` cards instead. This counts as a no-op iteration. The benchmark logs it, counts it against `maxIterations`, and retries with a more directive prompt: "Please propose a specific fix for the failing tests. Emit a proposal card with the changes."
- **Multiple proposals in one turn**: If the agent emits multiple proposal cards (e.g., `add_variables` + `add_rules`), the benchmark processes them sequentially — approve the first, wait for completion, then approve the second. Each gets its own approval code.
- **Build error in tool response**: The agent receives the error from the MCP tool and explains it in its response. The benchmark detects this by inspecting `toolCalls` for error results (using the `isToolResultError` pattern from `src/utils/retry.ts`). This counts as a failed iteration but not a fatal error.
- **Approval code rejected**: If `consumeApprovalCode` returns false (file not written yet, code already consumed), the MCP tool returns an error. The benchmark detects this and retries with a fresh code rather than counting it as a failed iteration.

#### Policy context provided to the agent

Each iteration sends the full policy context including:
- `policyArn`
- `policyDefinition` (re-exported after each iteration to reflect changes)
- `sourceDocumentText` (from the fixture)
- `testCases` (with latest results)
- Fidelity report data (if available — provides root-cause signal for accuracy issues)

### 4. Evaluation (`evaluation.ts`)

Two evaluation modes:

#### Deterministic Evaluation

Computed directly from the repair session data:

```typescript
interface DeterministicEvaluation {
  /** Did all tests pass by the end? */
  allTestsPassed: boolean;
  /** Total iterations to convergence (or maxIterations if not converged). */
  iterationsToConverge: number;
  /** Per-test: which iteration did it first pass? */
  perTestConvergence: { testCaseId: string; firstPassedAtIteration: number | null }[];
  /** Total wall-clock time. */
  totalLatencyMs: number;
  /** Per-iteration latency breakdown. */
  perIterationLatencyMs: number[];
  /** Number of tool calls made. */
  totalToolCalls: number;
  /** Number of build errors encountered. */
  totalBuildErrors: number;
  /** Number of no-op iterations (agent didn't propose a fix). */
  noOpIterations: number;
}
```

#### LLM-as-Judge Evaluation

For each policy change the agent made, a separate LLM call evaluates generalizability. Uses structured JSON output mode with low temperature (0.1) for consistency.

```typescript
interface JudgeEvaluation {
  changes: ChangeAssessment[];
  overallScore: number;  // 1-5
  summary: string;
}

interface ChangeAssessment {
  changeDescription: string;
  generalizability: "generalizable" | "likely_overfitting" | "unclear";
  paraphraseRobustness: "robust" | "fragile" | "unknown";
  rootCauseAddressed: boolean;
  reasoning: string;
}
```

The judge prompt includes:
- The original policy definition (before changes)
- The source document text
- The specific change the agent made (rule expression, variable description, etc.)
- The test case that motivated the change
- 2-3 paraphrased versions of the test case (generated alongside the judge prompt) to give the judge concrete examples to evaluate against
- The fidelity report's accuracy justification for the affected rule (if available)

The judge is asked to return a JSON object matching the `ChangeAssessment` schema. The prompt explicitly requests: "Evaluate whether this change would produce correct results for the following paraphrased test inputs, or whether it is narrowly tailored to pass only the original test text."

The judge model should be different from the agent model to avoid self-evaluation bias. Uses Claude Opus 4.6 (`anthropic.claude-opus-4-20250514-v1:0`) via Bedrock InvokeModel with temperature 0.1.

### 5. Report Generator (`report-generator.ts`)

Produces a self-contained HTML file with embedded CSS and JavaScript (Chart.js via CDN) containing:

#### Summary Section
- Pass/fail badge (did all tests pass?)
- Total iterations to convergence
- Total wall-clock time
- Number of tool calls
- Overall LLM judge score (1-5)

#### Charts
1. **Tests Passing Over Time** — line chart, x-axis = iteration number (starting from 0 = baseline), y-axis = number of passing tests. Shows convergence trajectory.
2. **Per-Iteration Latency** — bar chart showing how long each iteration took.
3. **Per-Test Convergence** — horizontal bar chart showing which iteration each test first passed at. Tests that never passed are shown in red.

#### Detailed Tables
1. **Iteration Log** — one row per iteration: prompt sent, tool calls made, tests passing/failing, latency, whether a proposal was emitted
2. **Per-Test Results** — one row per test: test content, expected result, iteration-by-iteration pass/fail status (as a heatmap row)
3. **LLM Judge Assessments** — one row per change: what changed, generalizability score, reasoning

#### Raw Data
- Collapsible sections with full agent responses, tool call arguments, and test findings for debugging

## Fixture Design

The benchmark uses a purpose-built expense approval policy rather than the BC camping sample. This gives us:
- A simple, intuitive domain (everyone understands expense reports)
- Small rule set (9 rules, 11 variables) — fast builds, easy to reason about
- Isolated deficiencies — each one produces a specific, predictable test failure
- No deep domain expertise required for the agent to propose correct fixes

### Domain: Acme Corp Expense Approval Policy

Source document (`expense-policy-document.md`) describes straightforward rules:
- Expenses ≤$100 are auto-approved
- $100-$5,000 need manager approval
- Over $5,000 need manager + finance approval
- International travel always needs finance approval
- Reimbursement within 5 days (under $1K) or 15 days ($1K+)
- Receipts required for expenses over $25

### Four Intentional Deficiencies

| ID | Deficiency | What's Wrong | Expected Failure Mode |
|---|---|---|---|
| D1 | Wrong implication direction | `(=> autoApproved (<= amount 100))` instead of `(=> (<= amount 100) autoApproved)` | Tests expecting auto-approval for small expenses fail — reasoner can't conclude `autoApproved` from amount |
| D2 | Wrong threshold constant | Finance approval rule uses `1000` instead of `5000` | $3,000 expense incorrectly triggers finance approval |
| D3 | Missing variable | `isInternational` variable omitted entirely | Tests about international travel get NO_TRANSLATIONS |
| D4 | Ambiguous description | `reimbursementDays` described as just "Days for reimbursement" | Tests about reimbursement timing get TRANSLATION_AMBIGUOUS |

### Test Cases (`expense-policy-tests.json`)

6 tests, with deliberate overlap to test fix generalizability:

| Test | Expected | Target | Purpose |
|---|---|---|---|
| $50 expense auto-approved | VALID | D1 | Core test for reversed implication |
| $100 expense auto-approved | VALID | D1 | Boundary value — validates fix generalizes |
| $3,000 expense needs no finance approval | INVALID | D2 | Wrong threshold makes this fail |
| $7,500 expense needs finance approval | VALID | D2 | Control — should pass even with wrong threshold; catches over-correction |
| $800 international travel needs finance approval | VALID | D3 | Missing variable causes NO_TRANSLATIONS |
| $500 expense reimbursed in 5 days | VALID | D4 | Ambiguous description causes TRANSLATION_AMBIGUOUS |

The D2 control test ($7,500) is important: it should pass from the start. If the agent "fixes" D2 by removing the finance approval rule entirely, this test will start failing — catching overfitting.

### Expected Agent Repair Path

The ideal repair sequence (not prescriptive — the agent may find a different valid path):

1. **D1 fix**: Reverse the implication in RULE_AUTO_APPROVE to `(=> (<= expenseAmount 100) autoApproved)`. This is a single `add_rules` call (delete old + add new, or the agent may use a different approach).
2. **D2 fix**: Update RULE_FINANCE_APPROVAL threshold from 1000 to 5000: `(=> (> expenseAmount 5000) requiresFinanceApproval)`.
3. **D3 fix**: Add `isInternational` variable with a rich description, then add a rule: `(=> isInternational requiresFinanceApproval)`.
4. **D4 fix**: Update `reimbursementDays` description to specify both tiers, or add two rules with a richer description.

Each fix is independent — the agent can address them in any order. A good prompt should fix 1-2 deficiencies per iteration, converging in 2-4 iterations.

## Running the Benchmark

```bash
# Run the full benchmark suite
npm run benchmark

# Run with custom max iterations
BENCHMARK_MAX_ITERATIONS=10 npm run benchmark

# Skip LLM judge evaluation (faster, deterministic only)
BENCHMARK_SKIP_JUDGE=1 npm run benchmark

# Clean up orphaned benchmark policies (from crashed runs)
npm run benchmark:cleanup
```

npm scripts:
```json
{
  "benchmark": "npx tsx benchmarks/src/benchmark-runner.ts",
  "benchmark:cleanup": "npx tsx benchmarks/src/cleanup-orphaned-policies.ts"
}
```

### Prerequisites
- Kiro CLI installed and on PATH
- Valid AWS credentials with Bedrock access
- ~25-45 minutes (each build cycle takes 3-5 minutes, up to 5 iterations, plus test execution and agent response time)

### Environment Variables
| Variable | Default | Description |
|---|---|---|
| `BENCHMARK_MAX_ITERATIONS` | `5` | Maximum repair iterations before giving up |
| `BENCHMARK_SKIP_JUDGE` | `0` | Set to `1` to skip LLM-as-judge evaluation |
| `BENCHMARK_REPORT_DIR` | `benchmarks/reports` | Output directory for HTML reports |
| `AWS_REGION` | `us-west-2` | AWS region for policy creation |
| `AWS_PROFILE` | (default) | AWS profile for credentials |

## TypeScript Configuration

`benchmarks/tsconfig.json` extends the root config and adds the `src/` directory to its scope so it can import services and types:

```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "rootDir": "..",
    "outDir": "../dist/benchmarks"
  },
  "include": ["src/**/*.ts", "../src/services/**/*.ts", "../src/types/**/*.ts", "../src/utils/**/*.ts", "../src/prompts/**/*.ts"]
}
```

The benchmark is run via `npx tsx` which handles TypeScript compilation on-the-fly, so no separate build step is needed.

## Error Handling and Crash Safety

### Guaranteed teardown

The benchmark runner wraps the entire lifecycle in try/finally:

```typescript
const harness = await createBenchmarkPolicy(policyService, fixture);
const chatService = new ChatService({ transport });
try {
  // baseline, agent loop, evaluation, report generation
} finally {
  chatService.stopProcess();  // kill kiro-cli subprocess
  await harness.cleanup();    // delete builds + policy
  fs.unlinkSync(approvalCodeFilePath);  // remove temp file
}
```

### SIGINT handler

```typescript
const cleanup = async () => {
  chatService.stopProcess();
  await harness.cleanup();
  process.exit(1);
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
```

### Orphaned policy cleanup

The `benchmark:cleanup` script lists all policies, finds those matching the `benchmark-*` naming pattern, and deletes them. This handles cases where the benchmark crashed without running teardown.

### AbortController

An `AbortController` is wired through `BenchmarkDeps`. Each step checks `signal.aborted` before proceeding. A global timeout (default: 60 minutes) triggers the abort, ensuring the benchmark doesn't hang indefinitely.

## Report Output

Reports are written to `benchmarks/reports/benchmark-<timestamp>.html` and are self-contained (no external dependencies except Chart.js CDN). Example filename: `benchmark-2026-03-05T14-30-00.html`.

A companion `benchmark-<timestamp>.json` file is written alongside the HTML with the raw `RepairSession` + evaluation data for programmatic comparison.

The `benchmarks/reports/` directory is gitignored. Developers compare reports manually after prompt changes.

### Example Report

A complete example report is available at [`docs/example-benchmark-report.html`](./example-benchmark-report.html). Open it in a browser to see the full layout with interactive charts. The example simulates a successful 3-iteration benchmark run against the expense policy fixture.

The report captures the following data points:

#### Summary Cards (top of report)
| Data Point | Example Value | Source |
|---|---|---|
| Tests passing (X / N) | 6 / 6 | `repairSession.finalPassCount` / total tests |
| LLM judge score | 4.2 / 5 | `judgeEvaluation.overallScore` |
| Iterations to convergence | 3 | `repairSession.iterations.length` |
| Total wall-clock time | 18m 42s | `repairSession.totalLatencyMs` |
| Tool calls (by type) | 9 (3 add_rules, 2 add_variables, 1 update_variables, 3 execute_tests) | Aggregated from `iteration.toolCalls` |
| Build errors | 0 | Aggregated from `iteration.buildErrorOccurred` |
| No-op iterations | 0 | Count of iterations where `proposalEmitted === false` |

#### Charts
| Chart | X-Axis | Y-Axis | Data Source |
|---|---|---|---|
| Tests Passing Over Time | Iteration (baseline, 1, 2, 3…) | Count of passing tests | `iteration.passingTests` per iteration |
| Per-Iteration Latency | Iteration | Seconds (stacked: agent+build vs test execution) | `iteration.latencyMs` split by phase |
| Per-Test Convergence | Iteration number | Test name (horizontal bars) | `perTestConvergence.firstPassedAtIteration` |

#### Iteration Log Table
Each row captures one iteration with:
- Prompt summary (what was sent to the agent)
- Whether a proposal card was emitted
- Tool calls made (tool name, success/failure)
- Tests passing / failing after this iteration
- Wall-clock latency

#### Per-Test Results Heatmap
Each row is a test case. Columns are iterations. Cells are color-coded PASS (green) / FAIL (red). The final column shows which iteration the test first passed at.

#### LLM Judge Table
Each row is a policy change the agent made:
- Change description (rule expression or variable update)
- Which iteration it occurred in
- Generalizability score (generalizable / likely_overfitting / unclear)
- Paraphrase robustness (robust / fragile / unknown)
- Whether root cause was addressed (yes / partial / no)
- Full reasoning text

#### Raw Data (collapsible)
- Full test results JSON for each iteration (findings, translations, supporting/contradicting rules)
- Full agent response text and all cards emitted
- Complete tool call inputs and outputs with latencies
- Policy definition diff (before/after with rules added, variables added/updated)
- LLM judge full response JSON for each change
- Benchmark metadata (versions, config, timing breakdown, ephemeral policy ARN)

## Future Extensions

- **Multiple fixtures**: Add more policy domains (HR, finance, healthcare) to test generalization across domains.
- **Regression tracking**: Build a dashboard that reads the JSON reports and tracks scores over time.
- **CI integration**: Run benchmarks on PR branches that touch prompt files, post summary as a PR comment.
- **A/B comparison**: Run the same fixture with two different prompts side-by-side and diff the reports.
- **Deterministic fixture mode**: For faster iteration, add an offline mode that mocks the build cycle and evaluates tool call correctness without real API calls.
- **Vitest runner**: Migrate from bare `tsx` to a `vitest.benchmark.config.ts` for consistency with the e2e test patterns and to get lifecycle hooks, timeout handling, and reporting for free.
