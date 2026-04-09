/**
 * Deterministic policy workflow orchestration.
 *
 * Encapsulates the multi-step workflows (REFINE_POLICY, fidelity reports,
 * test execution) that the agent previously had to execute step-by-step
 * via CLI commands. Each public method is a single tool the agent can call.
 *
 * Depends only on PolicyService (raw SDK calls) and types.
 */
import type { PolicyService, BuildWorkflowInfo } from "./policy-service";
import { ACTIVE_TEST_STATUSES, PollTimeoutError } from "./policy-service";
import type {
  PolicyDefinition,
  FidelityReport,
  BuildLogEntry,
} from "../types";
import { toAppDefinition } from "../utils/policy-definition";
import type {
  AutomatedReasoningPolicyDefinition,
  AutomatedReasoningPolicyAnnotation,
  AutomatedReasoningCheckResult,
  AutomatedReasoningCheckFinding,
  AutomatedReasoningPolicyBuildWorkflowType,
} from "@aws-sdk/client-bedrock";
import { isThrottlingError, pollUntil, PollTimeoutError as GenericPollTimeoutError } from "../utils/retry";
import { parseFidelityAsset } from "../utils/fidelity";
import { runFidelityBuildWorkflow } from "./fidelity-workflow";
import { parseBuildLogAsset, extractBuildErrors } from "../utils/build-log";

// ── Progress & Error types ──

export type ProgressCallback = (message: string) => void;

export class BuildLimitError extends Error {
  constructor(message = "Could not free a build slot — delete a build manually and retry.") {
    super(message);
    this.name = "BuildLimitError";
  }
}

export class BuildFailedError extends Error {
  constructor(
    public readonly buildWorkflowId: string,
    status: string,
    public readonly buildLog: BuildLogEntry[] = [],
  ) {
    super(`Build ${buildWorkflowId} ended with status: ${status}`);
    this.name = "BuildFailedError";
  }
}

export class BuildTimeoutError extends Error {
  constructor(public readonly buildWorkflowId: string) {
    super(`Build ${buildWorkflowId} polling timed out`);
    this.name = "BuildTimeoutError";
  }
}

// ── Tool input / output types ──

export interface AddRuleInput {
  expression: string;
}

/** Options for controlling polling intervals — useful for testing with fake timers. */
export interface PollingOptions {
  /** Milliseconds between poll attempts for build completion (default: 3000). */
  buildIntervalMs?: number;
  /** Maximum poll attempts for build completion (default: 100). */
  buildMaxAttempts?: number;
  /** Milliseconds between poll attempts for test results (default: 2000). */
  testIntervalMs?: number;
  /** Maximum poll attempts for test results (default: 60). */
  testMaxAttempts?: number;
}

export interface AddVariableInput {
  name: string;
  type: string;
  description: string;
}

export interface UpdateVariableInput {
  name: string;
  newName?: string;
  description: string;
}


export interface UpdateTestInput {
  testCaseId: string;
  guardContent?: string;
  queryContent?: string;
  expectedResult?: "VALID" | "SATISFIABLE" | "INVALID" | "IMPOSSIBLE";
}

export interface FindingOutput {
  type: string;
  description: string;
  /** Full finding data — the raw SDK finding for the agent to analyze. */
  raw: Record<string, unknown>;
}

export interface TestResultOutput {
  testCaseId: string;
  guardContent: string;
  queryContent: string;
  expectedResult: string;
  actualResult: string;
  passed: boolean;
  findings: FindingOutput[];
}

export interface RefinePolicyResult {
  policyDefinition: PolicyDefinition;
  buildWorkflowId: string;
  /** Build log entries — always fetched so the agent can see what happened. */
  buildLog: BuildLogEntry[];
  /** Errors extracted from the build log for easy consumption. */
  buildErrors: string[];
}

// ── Helpers ──

/**
 * Extract a human-readable summary from an SDK AutomatedReasoningCheckFinding
 * discriminated union member, and include the full raw finding for the agent.
 */
function summarizeFinding(finding: AutomatedReasoningCheckFinding): FindingOutput {
  if ("valid" in finding && finding.valid) {
    return { type: "VALID", description: "The claims are valid and implied by the policy.", raw: finding.valid as unknown as Record<string, unknown> };
  }
  if ("invalid" in finding && finding.invalid) {
    return { type: "INVALID", description: "Claims are contradicted by the policy.", raw: finding.invalid as unknown as Record<string, unknown> };
  }
  if ("satisfiable" in finding && finding.satisfiable) {
    return { type: "SATISFIABLE", description: "Claims could be true or false depending on additional assumptions.", raw: finding.satisfiable as unknown as Record<string, unknown> };
  }
  if ("impossible" in finding && finding.impossible) {
    return { type: "IMPOSSIBLE", description: "The premises are logically inconsistent or conflict with the policy.", raw: finding.impossible as unknown as Record<string, unknown> };
  }
  if ("translationAmbiguous" in finding && finding.translationAmbiguous) {
    return { type: "TRANSLATION_AMBIGUOUS", description: "Multiple interpretations detected — variable descriptions may need improvement.", raw: finding.translationAmbiguous as unknown as Record<string, unknown> };
  }
  if ("noTranslations" in finding && finding.noTranslations) {
    return { type: "NO_TRANSLATIONS", description: "No relevant logical information could be extracted from the input.", raw: finding.noTranslations as unknown as Record<string, unknown> };
  }
  if ("tooComplex" in finding && finding.tooComplex) {
    return { type: "TOO_COMPLEX", description: "Input exceeds processing capacity.", raw: finding.tooComplex as unknown as Record<string, unknown> };
  }
  return { type: "UNKNOWN", description: "Unrecognized finding type.", raw: {} };
}

// ── Service ──

export class PolicyWorkflowService {
  constructor(private policyService: PolicyService) {}

  // ── Tool 1: Generate Fidelity Report ──

  async generateFidelityReport(
    policyArn: string,
    onProgress?: ProgressCallback,
    sourceDocumentText?: string,
    pollingOptions?: PollingOptions,
  ): Promise<{ buildWorkflowId: string; report: FidelityReport; sourceDocumentText: string }> {
    onProgress?.("Exporting current policy definition…");
    const definition = await this.policyService.exportPolicyDefinition(policyArn);

    const result = await runFidelityBuildWorkflow(
      this.policyService,
      policyArn,
      definition,
      sourceDocumentText,
      {
        onProgress,
        pollIntervalMs: pollingOptions?.buildIntervalMs,
        pollMaxAttempts: pollingOptions?.buildMaxAttempts,
      },
    );

    // Extract source document text from the report's annotated document content
    const extractedDocumentText = (result.report.documentSources ?? [])
      .map((doc) => {
        const lines = (doc.documentContent ?? [])
          .flatMap((chunk) => (chunk.content ?? []).map((line) => line.lineText))
          .filter(Boolean);
        return lines.join("\n");
      })
      .join("\n\n---\n\n");

    // Clean up old builds, keep only this one
    onProgress?.("Cleaning up old builds…");
    await this.policyService.manageBuildSlot(policyArn, "GENERATE_FIDELITY_REPORT", result.buildWorkflowId);

    return { buildWorkflowId: result.buildWorkflowId, report: result.report, sourceDocumentText: extractedDocumentText };
  }

  // ── Tool 2: Add Rules ──

  async addRules(
    policyArn: string,
    rules: AddRuleInput[],
    onProgress?: ProgressCallback,
    pollingOptions?: PollingOptions,
  ): Promise<RefinePolicyResult> {
    if (rules.length === 0) throw new Error("At least one rule is required.");
    if (rules.length > 10) throw new Error("Maximum 10 rules per call (API annotation limit).");

    const annotations: AutomatedReasoningPolicyAnnotation[] = rules.map((r) => ({
      addRule: { expression: r.expression },
    } as AutomatedReasoningPolicyAnnotation));

    return this.executeRefinePolicyWorkflow(policyArn, annotations, onProgress, pollingOptions);
  }

  // ── Tool 3: Add Variables ──

  async addVariables(
    policyArn: string,
    variables: AddVariableInput[],
    onProgress?: ProgressCallback,
    pollingOptions?: PollingOptions,
  ): Promise<RefinePolicyResult> {
    if (variables.length === 0) throw new Error("At least one variable is required.");
    if (variables.length > 10) throw new Error("Maximum 10 variables per call (API annotation limit).");

    // Validate variable types — only 'BOOL', 'INT', 'REAL', or custom type names are valid.
    const BUILTIN_TYPES = new Set(["BOOL", "INT", "REAL"]);
    const INVALID_ALIASES: Record<string, string> = {
      bool: "BOOL", boolean: "BOOL", int: "INT", integer: "INT", number: "INT",
      real: "REAL", float: "REAL", decimal: "REAL", double: "REAL",
      string: "a custom type", enum: "a custom type",
    };
    for (const v of variables) {
      const lower = v.type?.toLowerCase();
      if (!BUILTIN_TYPES.has(v.type) && INVALID_ALIASES[lower]) {
        throw new Error(
          `Invalid variable type '${v.type}' for '${v.name}'. ` +
          `Valid built-in types are 'BOOL', 'INT', 'REAL'. ` +
          `Did you mean '${INVALID_ALIASES[lower]}'?`,
        );
      }
    }

    const annotations: AutomatedReasoningPolicyAnnotation[] = variables.map((v) => ({
      addVariable: {
        name: v.name,
        type: v.type,
        description: v.description,
      },
    } as AutomatedReasoningPolicyAnnotation));

    return this.executeRefinePolicyWorkflow(policyArn, annotations, onProgress, pollingOptions);
  }

  // ── Tool 4: Update Variables ──

  async updateVariables(
    policyArn: string,
    variables: UpdateVariableInput[],
    onProgress?: ProgressCallback,
    pollingOptions?: PollingOptions,
  ): Promise<RefinePolicyResult> {
    if (variables.length === 0) throw new Error("At least one variable is required.");
    if (variables.length > 10) throw new Error("Maximum 10 variables per call (API annotation limit).");

    const annotations: AutomatedReasoningPolicyAnnotation[] = variables.map((v) => ({
      updateVariable: {
        name: v.name,
        ...(v.newName ? { newName: v.newName } : {}),
        description: v.description,
      },
    } as AutomatedReasoningPolicyAnnotation));

    return this.executeRefinePolicyWorkflow(policyArn, annotations, onProgress, pollingOptions);
  }

  async deleteRules(
    policyArn: string,
    ruleIds: string[],
    onProgress?: ProgressCallback,
    pollingOptions?: PollingOptions,
  ): Promise<RefinePolicyResult> {
    if (ruleIds.length === 0) throw new Error("At least one rule ID is required.");
    if (ruleIds.length > 10) throw new Error("Maximum 10 rules per call (API annotation limit).");

    const annotations: AutomatedReasoningPolicyAnnotation[] = ruleIds.map((ruleId) => ({
      deleteRule: { ruleId },
    } as AutomatedReasoningPolicyAnnotation));

    return this.executeRefinePolicyWorkflow(policyArn, annotations, onProgress, pollingOptions);
  }

  async deleteVariables(
    policyArn: string,
    variableNames: string[],
    onProgress?: ProgressCallback,
    pollingOptions?: PollingOptions,
  ): Promise<RefinePolicyResult> {
    if (variableNames.length === 0) throw new Error("At least one variable name is required.");
    if (variableNames.length > 10) throw new Error("Maximum 10 variables per call (API annotation limit).");

    const annotations: AutomatedReasoningPolicyAnnotation[] = variableNames.map((name) => ({
      deleteVariable: { name },
    } as AutomatedReasoningPolicyAnnotation));

    return this.executeRefinePolicyWorkflow(policyArn, annotations, onProgress, pollingOptions);
  }

  // ── Tool 5: Execute Tests ──

  async executeTests(
      policyArn: string,
      testCaseIds: string[],
      onProgress?: ProgressCallback,
      pollingOptions?: PollingOptions,
    ): Promise<TestResultOutput[]> {
      if (testCaseIds.length === 0) throw new Error("At least one test case ID is required.");

      // Step 1: Find the latest completed build to test against
      onProgress?.("Finding latest build…");
      const builds = await this.policyService.listBuilds(policyArn);
      const latestBuild = this.policyService.findLatestPolicyBuild(builds);

      if (!latestBuild) {
        throw new Error("No completed build found. Add rules or variables first to create a build.");
      }
      const buildWorkflowId = latestBuild.buildWorkflowId;

      // Step 2: Fetch test case details for the output
      onProgress?.("Fetching test case details…");
      const testCases = await Promise.all(
        testCaseIds.map((id) => this.policyService.getTestCase(policyArn, id)),
      );

      // Step 3: Run tests against the latest build
      onProgress?.("Running tests…");
      await this.policyService.runTests(policyArn, buildWorkflowId, testCaseIds);

      // Step 4: Poll until all tests reach a terminal status
      onProgress?.("Waiting for test results…");
      const results = await this.pollTestResults(
        policyArn, buildWorkflowId, testCaseIds, onProgress, pollingOptions,
      );

      // Step 5: Notify listeners that tests finished
      this.policyService.emitTestsExecuted?.(policyArn, buildWorkflowId);

      // Step 6: Merge test case details with results
      return results.map((r, i) => ({
        testCaseId: testCaseIds[i],
        guardContent: testCases[i].guardContent ?? "",
        queryContent: testCases[i].queryContent ?? "",
        expectedResult: (testCases[i].expectedAggregatedFindingsResult ?? "UNKNOWN") as string,
        actualResult: r.actualResult,
        passed: r.passed,
        findings: r.findings,
      }));
    }

  /**
   * Update existing test cases with new guard content, query content, and/or expected results.
   * Fetches each test case first to get the lastUpdatedAt concurrency token,
   * then applies the updates.
   */
  async updateTests(
    policyArn: string,
    updates: UpdateTestInput[],
    onProgress?: ProgressCallback,
  ): Promise<{ testCaseId: string; guardContent: string; queryContent: string; expectedResult: string }[]> {
    if (updates.length === 0) throw new Error("At least one test update is required.");

    const results: { testCaseId: string; guardContent: string; queryContent: string; expectedResult: string }[] = [];

    for (const update of updates) {
      onProgress?.(`Fetching test case ${update.testCaseId}…`);
      const existing = await this.policyService.getTestCase(policyArn, update.testCaseId);

      const guardContent = update.guardContent ?? existing.guardContent!;
      const queryContent = update.queryContent ?? existing.queryContent ?? "";
      const expectedResult = (update.expectedResult ?? existing.expectedAggregatedFindingsResult!) as AutomatedReasoningCheckResult;

      onProgress?.(`Updating test case ${update.testCaseId}…`);
      await this.policyService.updateTestCase(
        policyArn,
        update.testCaseId,
        guardContent,
        queryContent,
        expectedResult,
        existing.updatedAt!,
      );

      results.push({
        testCaseId: update.testCaseId,
        guardContent,
        queryContent,
        expectedResult: expectedResult as string,
      });
    }

    onProgress?.(`Updated ${results.length} test case(s).`);
    return results;
  }

  /**
   * Delete one or more test cases by ID.
   * Fetches each test case first to get the lastUpdatedAt concurrency token.
   */
  async deleteTests(
    policyArn: string,
    testCaseIds: string[],
    onProgress?: ProgressCallback,
  ): Promise<string[]> {
    if (testCaseIds.length === 0) throw new Error("At least one test case ID is required.");

    const deleted: string[] = [];
    for (const testCaseId of testCaseIds) {
      onProgress?.(`Fetching test case ${testCaseId}…`);
      const existing = await this.policyService.getTestCase(policyArn, testCaseId);

      onProgress?.(`Deleting test case ${testCaseId}…`);
      await this.policyService.deleteTestCase(policyArn, testCaseId, existing.updatedAt!);
      deleted.push(testCaseId);
    }

    onProgress?.(`Deleted ${deleted.length} test case(s).`);
    return deleted;
  }

  // ── Private: Shared REFINE_POLICY workflow ──

  private async executeRefinePolicyWorkflow(
    policyArn: string,
    annotations: AutomatedReasoningPolicyAnnotation[],
    onProgress?: ProgressCallback,
    pollingOptions?: PollingOptions,
  ): Promise<RefinePolicyResult> {
    // Step 1: Get current DRAFT definition
    onProgress?.("Exporting current policy definition…");
    const currentDefinition = await this.policyService.exportPolicyDefinition(policyArn);

    // Step 2: Ensure build slot — delete oldest completed build if at limit
    await this.ensureBuildSlot(policyArn, "REFINE_POLICY", onProgress);

    // Step 3: Start REFINE_POLICY build
    onProgress?.("Starting policy refinement build…");
    const buildId = await this.policyService.startBuild(policyArn, "REFINE_POLICY", {
      policyDefinition: currentDefinition,
      workflowContent: {
        policyRepairAssets: { annotations },
      },
    });

    // Step 4: Poll until complete
    onProgress?.("Building — this may take a minute…");
    const build = await this.pollBuildToCompletion(
      policyArn, buildId, onProgress, pollingOptions,
    );

    // Step 5: Always fetch the build log for diagnostics
    onProgress?.("Retrieving build log…");
    const { buildLog, buildErrors } = await this.fetchBuildLog(policyArn, build.buildWorkflowId);

    // Step 6: Retrieve new definition from the build output
    onProgress?.("Retrieving updated policy definition…");
    const asset = await this.policyService.getBuildAssets(
      policyArn, build.buildWorkflowId, "POLICY_DEFINITION",
    );
    if (!asset) {
      throw new BuildFailedError(buildId, "COMPLETED (no policy definition asset)", buildLog);
    }

    const rawDef = (asset as unknown as Record<string, unknown>)
      .policyDefinition as AutomatedReasoningPolicyDefinition | undefined;
    if (!rawDef) {
      throw new BuildFailedError(buildId, "COMPLETED (policy definition empty)", buildLog);
    }

    // Step 7: Apply the build output to the DRAFT policy
    onProgress?.("Applying updated definition to policy…");
    await this.policyService.updatePolicy(policyArn, rawDef);

    // Step 8: Re-export the definition to confirm the update was applied
    onProgress?.("Confirming policy update…");
    let confirmedDef: AutomatedReasoningPolicyDefinition;
    try {
      confirmedDef = await this.policyService.exportPolicyDefinition(policyArn);
    } catch (err) {
      console.warn("[executeRefinePolicyWorkflow] Post-update export failed (non-critical):", (err as Error).message);
      confirmedDef = rawDef;
    }

    // Step 9: Clean up old builds, keep only this one
    onProgress?.("Cleaning up old builds…");
    await this.policyService.manageBuildSlot(policyArn, "REFINE_POLICY", buildId);

    return {
      policyDefinition: toAppDefinition(confirmedDef),
      buildWorkflowId: buildId,
      buildLog,
      buildErrors,
    };
  }

  // ── Private: Build slot management ──

  private async ensureBuildSlot(
      policyArn: string,
      buildType: AutomatedReasoningPolicyBuildWorkflowType,
      onProgress?: ProgressCallback,
    ): Promise<void> {
      onProgress?.("Cleaning up old build to make room…");
      try {
        await this.policyService.manageBuildSlot(policyArn, buildType);
      } catch (err) {
        throw new BuildLimitError((err as Error).message);
      }
    }


  // ── Private: Build polling ──

  private async pollBuildToCompletion(
    policyArn: string,
    buildWorkflowId: string,
    _onProgress?: ProgressCallback,
    pollingOptions?: Pick<PollingOptions, "buildIntervalMs" | "buildMaxAttempts">,
  ): Promise<BuildWorkflowInfo> {
    const intervalMs = pollingOptions?.buildIntervalMs ?? 3000;
    const maxAttempts = pollingOptions?.buildMaxAttempts ?? 100;
    try {
      const build = await this.policyService.pollBuild(policyArn, buildWorkflowId, intervalMs, maxAttempts);
        if (build.status !== "COMPLETED") {
          const { buildLog } = await this.fetchBuildLog(policyArn, buildWorkflowId);
          throw new BuildFailedError(buildWorkflowId, build.status, buildLog);
        }
        return build;
      } catch (err) {
        if (err instanceof BuildFailedError) throw err;
        if (err instanceof PollTimeoutError) {
          throw new BuildTimeoutError(buildWorkflowId);
        }
        throw err;
      }
    }


  // ── Private: Test result polling ──

  private async pollTestResults(
    policyArn: string,
    buildWorkflowId: string,
    testCaseIds: string[],
    onProgress?: ProgressCallback,
    pollingOptions?: Pick<PollingOptions, "testIntervalMs" | "testMaxAttempts">,
  ): Promise<{ actualResult: string; passed: boolean; findings: FindingOutput[] }[]> {
    const intervalMs = pollingOptions?.testIntervalMs ?? 2000;
    const maxAttempts = pollingOptions?.testMaxAttempts ?? 60;
    const results = new Map<string, { actualResult: string; passed: boolean; findings: FindingOutput[] }>();

    const fetchPendingResults = async (): Promise<Map<string, { actualResult: string; passed: boolean; findings: FindingOutput[] }>> => {
      for (const id of testCaseIds) {
        if (results.has(id)) continue;
        const res = await this.policyService.getTestResult(policyArn, buildWorkflowId, id);
        const result = res.testResult;
        if (result && !ACTIVE_TEST_STATUSES.has(result.testRunStatus!)) {
          const actual = result.aggregatedTestFindingsResult ?? "UNKNOWN";
          const expected = result.testCase?.expectedAggregatedFindingsResult ?? "UNKNOWN";
          results.set(id, {
            actualResult: actual,
            passed: actual === expected,
            findings: (result.testFindings ?? []).map(summarizeFinding),
          });
        }
      }
      return results;
    };

    try {
      await pollUntil(
        fetchPendingResults,
        (r) => {
          if (r.size === testCaseIds.length) {
            onProgress?.("All tests completed.");
            return true;
          }
          onProgress?.(`Waiting for tests… (${r.size}/${testCaseIds.length} done)`);
          return false;
        },
        { intervalMs, maxAttempts },
        `tests for build ${buildWorkflowId}`,
      );
    } catch (err) {
      if (!(err instanceof GenericPollTimeoutError)) throw err;
      // Timed out — fall through to return partial results
    }

    return testCaseIds.map((id) =>
      results.get(id) ?? { actualResult: "TIMEOUT", passed: false, findings: [] },
    );
  }

  // ── Private: Build log fetching ──

  /**
   * Fetch the BUILD_LOG asset and extract entries + errors.
   * Returns empty arrays if the log can't be retrieved (non-fatal).
   */
  private async fetchBuildLog(
    policyArn: string,
    buildWorkflowId: string,
  ): Promise<{ buildLog: BuildLogEntry[]; buildErrors: string[] }> {
    try {
      const asset = await this.policyService.getBuildAssets(policyArn, buildWorkflowId, "BUILD_LOG");
      if (!asset) return { buildLog: [], buildErrors: [] };

      const buildLog = parseBuildLogAsset(asset);
      const buildErrors = extractBuildErrors(buildLog);

      return { buildLog, buildErrors };
    } catch {
      console.warn(`[PolicyWorkflowService] Failed to fetch build log for ${buildWorkflowId} (non-critical)`);
      return { buildLog: [], buildErrors: [] };
    }
  }
}
