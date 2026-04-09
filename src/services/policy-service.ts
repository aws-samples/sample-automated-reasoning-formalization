/**
 * Wrapper around Automated Reasoning checks control plane APIs.
 * Handles policy CRUD, build workflows, and test management.
 */
import {
  BedrockClient,
  CreateAutomatedReasoningPolicyCommand,
  GetAutomatedReasoningPolicyCommand,
  UpdateAutomatedReasoningPolicyCommand,
  DeleteAutomatedReasoningPolicyCommand,
  ListAutomatedReasoningPoliciesCommand,
  ExportAutomatedReasoningPolicyVersionCommand,
  CreateAutomatedReasoningPolicyVersionCommand,
  StartAutomatedReasoningPolicyBuildWorkflowCommand,
  GetAutomatedReasoningPolicyBuildWorkflowCommand,
  DeleteAutomatedReasoningPolicyBuildWorkflowCommand,
  ListAutomatedReasoningPolicyBuildWorkflowsCommand,
  GetAutomatedReasoningPolicyBuildWorkflowResultAssetsCommand,
  CreateAutomatedReasoningPolicyTestCaseCommand,
  GetAutomatedReasoningPolicyTestCaseCommand,
  UpdateAutomatedReasoningPolicyTestCaseCommand,
  DeleteAutomatedReasoningPolicyTestCaseCommand,
  ListAutomatedReasoningPolicyTestCasesCommand,
  StartAutomatedReasoningPolicyTestWorkflowCommand,
  GetAutomatedReasoningPolicyTestResultCommand,
  ListAutomatedReasoningPolicyTestResultsCommand,
} from "@aws-sdk/client-bedrock";
import type {
  AutomatedReasoningPolicyDefinition,
  AutomatedReasoningPolicyBuildWorkflowType,
  AutomatedReasoningPolicyBuildWorkflowStatus,
  AutomatedReasoningPolicyBuildWorkflowSource,
  AutomatedReasoningPolicyBuildResultAssets,
  AutomatedReasoningPolicyTestResult,
  AutomatedReasoningPolicyTestCase,
  AutomatedReasoningCheckResult,
} from "@aws-sdk/client-bedrock";
import type { TestCaseWithResult } from "../types";
import { DEFAULT_AWS_REGION } from "../types";
import { isThrottlingError, pollUntil, PollTimeoutError as GenericPollTimeoutError } from "../utils/retry";

export interface PolicyInfo {
  policyArn: string;
  name: string;
  definitionHash: string;
}

export interface BuildWorkflowInfo {
  buildWorkflowId: string;
  buildWorkflowType: AutomatedReasoningPolicyBuildWorkflowType;
  status: AutomatedReasoningPolicyBuildWorkflowStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** Thrown when pollBuild exceeds its maximum attempts. */
export class PollTimeoutError extends Error {
  constructor(public readonly buildWorkflowId: string) {
    super(`Build polling timed out for ${buildWorkflowId}`);
    this.name = "PollTimeoutError";
  }
}

/** Poll interval for long-running section import builds (ms). */
export const SECTION_IMPORT_POLL_INTERVAL_MS = 3_000;
/** Maximum poll attempts for section import builds (3 000 ms × 1 200 = 1 hour). */
export const SECTION_IMPORT_MAX_POLL_ATTEMPTS = 1_200;

/** Build statuses that indicate a build is still running. */
export const ACTIVE_BUILD_STATUSES = new Set<string>([
  "SCHEDULED",
  "CANCEL_REQUESTED",
  "PREPROCESSING",
  "BUILDING",
  "TESTING",
]);

/** Build statuses that indicate a build has finished. */
export const TERMINAL_BUILD_STATUSES = new Set<string>([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

/** Test run statuses that indicate a test is still running. */
export const ACTIVE_TEST_STATUSES = new Set<string>([
  "IN_PROGRESS",
  "SCHEDULED",
  "NOT_STARTED",
]);

/** Maximum number of builds allowed per pool (policy builds vs fidelity builds). */
export const MAX_BUILDS_PER_POOL = 2;

/** Build types that belong to the fidelity report pool. */
const FIDELITY_BUILD_TYPES: ReadonlySet<string> = new Set(["GENERATE_FIDELITY_REPORT"]);

/** Returns true if the build belongs to the fidelity report pool. */
function isFidelityBuildType(type: string): boolean {
  return FIDELITY_BUILD_TYPES.has(type);
}

/** Merge a test case with its optional result into a single object. */
function mergeTestCaseWithResult(
  testCase: AutomatedReasoningPolicyTestCase,
  result?: AutomatedReasoningPolicyTestResult
): TestCaseWithResult {
  if (!result) return { testCase };
  return {
    testCase,
    testRunStatus: result.testRunStatus,
    testRunResult: result.testRunResult,
    testFindings: result.testFindings,
    aggregatedTestFindingsResult: result.aggregatedTestFindingsResult,
    resultUpdatedAt: result.updatedAt,
  };
}

export interface PolicyServiceConfig {
  /** AWS region. Defaults to DEFAULT_AWS_REGION ("us-west-2"). */
  region?: string;
  /** Explicit credentials (used by MCP server subprocess). */
  credentials?: BedrockClient['config']['credentials'];
  /** Pre-built client — when provided, region and credentials are ignored. Useful for testing. */
  client?: BedrockClient;
}

export class PolicyService {
  private readonly client: BedrockClient;

  /** Listeners notified after any test execution completes (poll finished). */
  private testsExecutedListeners: ((policyArn: string, buildWorkflowId: string) => void)[] = [];

  /** Subscribe to test-execution-completed events. Returns an unsubscribe function. */
  onTestsExecuted(listener: (policyArn: string, buildWorkflowId: string) => void): () => void {
    this.testsExecutedListeners.push(listener);
    return () => {
      this.testsExecutedListeners = this.testsExecutedListeners.filter((fn) => fn !== listener);
    };
  }

  /** Notify all listeners that a test execution completed. */
  emitTestsExecuted(policyArn: string, buildWorkflowId: string): void {
    for (const fn of this.testsExecutedListeners) {
      fn(policyArn, buildWorkflowId);
    }
  }

  /**
   * @param regionOrConfig — Either a region string (legacy) or a config object.
   *   Pass a `client` in the config to inject a pre-built BedrockClient (e.g. for tests).
   *   In the renderer, credentials come from window.architect (preload bridge).
   *   In the MCP server subprocess, pass explicit credentials from the AWS SDK.
   */
  constructor(regionOrConfig: string | PolicyServiceConfig = DEFAULT_AWS_REGION) {
    const config = typeof regionOrConfig === "string"
      ? { region: regionOrConfig }
      : regionOrConfig;

    if (config.client) {
      this.client = config.client;
    } else {
      const region = config.region ?? DEFAULT_AWS_REGION;
      this.client = new BedrockClient({
        region,
        credentials: config.credentials ?? (() => window.architect.getCredentials()),
      });
    }
  }

  // ── Policy CRUD ──

  async createPolicy(name: string): Promise<string> {
    const res = await this.client.send(
      new CreateAutomatedReasoningPolicyCommand({ name })
    );
    return res.policyArn!; // guaranteed by API contract
  }

  /**
   * Get policy metadata (no definition). Use exportPolicyDefinition() for the actual definition.
   */
  async getPolicy(policyArn: string): Promise<PolicyInfo> {
    const res = await this.client.send(
      new GetAutomatedReasoningPolicyCommand({ policyArn })
    );
    return {
      policyArn: res.policyArn!, // guaranteed by API contract
      name: res.name!, // guaranteed by API contract
      definitionHash: res.definitionHash!, // guaranteed by API contract
    };
  }

  /**
   * Export the full policy definition (rules, variables, types).
   * Works for both draft (unversioned ARN) and versioned ARNs.
   */
  async exportPolicyDefinition(
    policyArn: string
  ): Promise<AutomatedReasoningPolicyDefinition> {
    const res = await this.client.send(
      new ExportAutomatedReasoningPolicyVersionCommand({ policyArn })
    );
    return res.policyDefinition!; // guaranteed by API contract
  }

  async updatePolicy(
    policyArn: string,
    definition: AutomatedReasoningPolicyDefinition
  ): Promise<void> {
    await this.client.send(
      new UpdateAutomatedReasoningPolicyCommand({
        policyArn,
        policyDefinition: definition,
      })
    );
  }


  async deletePolicy(policyArn: string): Promise<void> {
    await this.client.send(
      new DeleteAutomatedReasoningPolicyCommand({ policyArn })
    );
  }

  async listPolicies(): Promise<{ policyArn: string; name: string; createdAt?: Date; updatedAt?: Date }[]> {
      const res = await this.client.send(
        new ListAutomatedReasoningPoliciesCommand({})
      );
      const policies = (res.automatedReasoningPolicySummaries ?? []).map((p) => ({
        policyArn: p.policyArn!, // guaranteed by API contract
        name: p.name!, // guaranteed by API contract
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      }));
      // Sort by most recently updated first, fall back to createdAt
      policies.sort((a, b) => {
        const dateA = a.updatedAt ?? a.createdAt ?? new Date(0);
        const dateB = b.updatedAt ?? b.createdAt ?? new Date(0);
        return dateB.getTime() - dateA.getTime();
      });
      return policies;
    }

  // ── Versions ──

  async createVersion(
    policyArn: string,
    lastUpdatedDefinitionHash: string
  ): Promise<{ policyArn: string; version: string }> {
    const res = await this.client.send(
      new CreateAutomatedReasoningPolicyVersionCommand({
        policyArn,
        lastUpdatedDefinitionHash,
      })
    );
    return {
      policyArn: res.policyArn!, // guaranteed by API contract
      version: res.version!, // guaranteed by API contract
    };
  }

  // ── Build workflows ──

  async startBuild(
    policyArn: string,
    type: AutomatedReasoningPolicyBuildWorkflowType,
    sourceContent: AutomatedReasoningPolicyBuildWorkflowSource
  ): Promise<string> {
    const res = await this.client.send(
      new StartAutomatedReasoningPolicyBuildWorkflowCommand({
        policyArn,
        buildWorkflowType: type,
        sourceContent,
      })
    );
    return res.buildWorkflowId!; // guaranteed by API contract
  }

  async getBuild(
    policyArn: string,
    buildWorkflowId: string
  ): Promise<BuildWorkflowInfo> {
    const res = await this.client.send(
      new GetAutomatedReasoningPolicyBuildWorkflowCommand({
        policyArn,
        buildWorkflowId,
      })
    );
    return {
      buildWorkflowId: res.buildWorkflowId!, // guaranteed by API contract
      buildWorkflowType: res.buildWorkflowType!, // guaranteed by API contract
      status: res.status!, // guaranteed by API contract
      createdAt: res.createdAt!, // guaranteed by API contract
      updatedAt: res.updatedAt!, // guaranteed by API contract
    };
  }

  async deleteBuild(
    policyArn: string,
    buildWorkflowId: string,
    lastUpdatedAt: Date
  ): Promise<void> {
    await this.client.send(
      new DeleteAutomatedReasoningPolicyBuildWorkflowCommand({
        policyArn,
        buildWorkflowId,
        lastUpdatedAt,
      })
    );
  }

  async listBuilds(policyArn: string): Promise<BuildWorkflowInfo[]> {
    const res = await this.client.send(
      new ListAutomatedReasoningPolicyBuildWorkflowsCommand({
        policyArn,
        maxResults: 50,
      })
    );
    return (res.automatedReasoningPolicyBuildWorkflowSummaries ?? []).map((b) => ({
      buildWorkflowId: b.buildWorkflowId!, // guaranteed by API contract
      buildWorkflowType: b.buildWorkflowType!, // guaranteed by API contract
      status: b.status!, // guaranteed by API contract
      createdAt: b.createdAt!, // guaranteed by API contract
      updatedAt: b.updatedAt!, // guaranteed by API contract
    }));
  }

  async getBuildAssets(
    policyArn: string,
    buildWorkflowId: string,
    assetType: "BUILD_LOG" | "QUALITY_REPORT" | "POLICY_DEFINITION" | "GENERATED_TEST_CASES" | "POLICY_SCENARIOS" | "FIDELITY_REPORT" | "ASSET_MANIFEST" | "SOURCE_DOCUMENT",
    assetId?: string,
  ): Promise<AutomatedReasoningPolicyBuildResultAssets | undefined> {
    const res = await this.client.send(
      new GetAutomatedReasoningPolicyBuildWorkflowResultAssetsCommand({
        policyArn,
        buildWorkflowId,
        assetType,
        ...(assetId ? { assetId } : {}),
      })
    );
    return res.buildWorkflowAssets;
  }

  // ── Polling helper ──

  async pollBuild(
    policyArn: string,
    buildWorkflowId: string,
    intervalMs = 3000,
    maxAttempts = 100
  ): Promise<BuildWorkflowInfo> {
    try {
      return await pollUntil(
        () => this.getBuild(policyArn, buildWorkflowId),
        (build) => !ACTIVE_BUILD_STATUSES.has(build.status),
        { intervalMs, maxAttempts },
        `build ${buildWorkflowId}`,
      );
    } catch (err) {
      if (err instanceof GenericPollTimeoutError) {
        throw new PollTimeoutError(buildWorkflowId);
      }
      throw err;
    }
  }
  /**
   * Start a GENERATE_FIDELITY_REPORT build workflow and return the workflow ID.
   * The caller should poll with `pollBuild` and then fetch the FIDELITY_REPORT asset.
   */
  async startFidelityReportBuild(
      policyArn: string,
      policyDefinition: AutomatedReasoningPolicyDefinition,
      sourceDocumentText?: string
    ): Promise<string> {
      const source: AutomatedReasoningPolicyBuildWorkflowSource = {
        policyDefinition,
      };
      if (sourceDocumentText) {
        source.workflowContent = {
          generateFidelityReportContent: {
            documents: [
              {
                document: new TextEncoder().encode(sourceDocumentText),
                documentContentType: "txt",
                documentName: "source-document",
                documentDescription: "Source document for fidelity grounding",
              },
            ],
          },
        };
      }
      return this.startBuild(policyArn, "GENERATE_FIDELITY_REPORT", source);
    }

  /**
   * Manage build slots within a single pool (policy or fidelity).
   *
   * When `keepBuildId` is provided (post-build cleanup), deletes all other
   * terminal builds in the same pool.
   *
   * When `keepBuildId` is omitted (pre-build slot opening), deletes the
   * oldest terminal build to free one slot if the pool is at capacity.
   */
    async manageBuildSlot(
      policyArn: string,
      buildType: AutomatedReasoningPolicyBuildWorkflowType,
      keepBuildId?: string,
    ): Promise<void> {
      const allBuilds = await this.listBuilds(policyArn);
      const isFidelityPool = isFidelityBuildType(buildType);

      // Partition: only manage builds in the same pool
      const poolBuilds = allBuilds.filter(
        (b) => isFidelityBuildType(b.buildWorkflowType) === isFidelityPool,
      );

      if (keepBuildId) {
        // Post-build cleanup: delete other terminal builds in the same pool
        const toDelete = poolBuilds.filter((b) => {
          if (b.buildWorkflowId === keepBuildId) return false;
          if (!TERMINAL_BUILD_STATUSES.has(b.status)) return false;
          return true;
        });

        for (const build of toDelete) {
          await this.deleteBuild(policyArn, build.buildWorkflowId, new Date(build.updatedAt));
        }
      } else {
        // Pre-build: free one slot if the pool is at capacity
        if (poolBuilds.length < MAX_BUILDS_PER_POOL) return;

        const completed = poolBuilds
          .filter((b) => TERMINAL_BUILD_STATUSES.has(b.status))
          .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

        const poolName = isFidelityPool ? "fidelity report" : "policy";
        if (completed.length === 0) {
          throw new Error(
            `All ${MAX_BUILDS_PER_POOL} ${poolName} build slots are in use. Wait for one to complete before starting another.`,
          );
        }

        await this.deleteBuild(policyArn, completed[0].buildWorkflowId, new Date(completed[0].updatedAt));
      }
    }

  /**
   * Find the most recent completed non-fidelity build from a list.
   * Returns undefined if no matching build exists.
   */
  findLatestPolicyBuild(builds: BuildWorkflowInfo[]): BuildWorkflowInfo | undefined {
    return builds
      .filter((b) => b.status === "COMPLETED" && b.buildWorkflowType !== "GENERATE_FIDELITY_REPORT")
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
  }


  // ── Tests ──

  async createTestCase(
    policyArn: string,
    guardContent: string,
    queryContent: string,
    expectedResult: AutomatedReasoningCheckResult
  ): Promise<string> {
    const res = await this.client.send(
      new CreateAutomatedReasoningPolicyTestCaseCommand({
        policyArn,
        guardContent,
        queryContent,
        expectedAggregatedFindingsResult: expectedResult,
      })
    );
    return res.testCaseId!; // guaranteed by API contract
  }

  async listTestCases(policyArn: string): Promise<AutomatedReasoningPolicyTestCase[]> {
    const allTestCases: AutomatedReasoningPolicyTestCase[] = [];
    let nextToken: string | undefined;
    do {
      const res = await this.client.send(
        new ListAutomatedReasoningPolicyTestCasesCommand({
          policyArn,
          maxResults: 100,
          ...(nextToken && { nextToken }),
        })
      );
      allTestCases.push(...(res.testCases ?? []));
      nextToken = res.nextToken;
    } while (nextToken);
    return allTestCases;
  }

  async getTestCase(policyArn: string, testCaseId: string): Promise<AutomatedReasoningPolicyTestCase> {
    const res = await this.client.send(
      new GetAutomatedReasoningPolicyTestCaseCommand({ policyArn, testCaseId })
    );
    return res.testCase!; // guaranteed by API contract
  }

  async updateTestCase(
    policyArn: string,
    testCaseId: string,
    guardContent: string,
    queryContent: string,
    expectedResult: AutomatedReasoningCheckResult,
    lastUpdatedAt: Date,
  ): Promise<void> {
    await this.client.send(
      new UpdateAutomatedReasoningPolicyTestCaseCommand({
        policyArn,
        testCaseId,
        guardContent,
        queryContent,
        expectedAggregatedFindingsResult: expectedResult,
        lastUpdatedAt,
      })
    );
  }

  async deleteTestCase(
    policyArn: string,
    testCaseId: string,
    lastUpdatedAt: Date,
  ): Promise<void> {
    await this.client.send(
      new DeleteAutomatedReasoningPolicyTestCaseCommand({
        policyArn,
        testCaseId,
        lastUpdatedAt,
      })
    );
  }

  async runTests(policyArn: string, buildWorkflowId: string, testCaseIds?: string[]): Promise<void> {
    await this.client.send(
      new StartAutomatedReasoningPolicyTestWorkflowCommand({
        policyArn,
        buildWorkflowId,
        ...(testCaseIds?.length ? { testCaseIds } : {}),
      })
    );
  }

  async getTestResult(
    policyArn: string,
    buildWorkflowId: string,
    testCaseId: string
  ): Promise<{ testResult?: AutomatedReasoningPolicyTestResult }> {
    return this.client.send(
      new GetAutomatedReasoningPolicyTestResultCommand({
        policyArn,
        buildWorkflowId,
        testCaseId,
      })
    );
  }

  async listTestResults(policyArn: string, buildWorkflowId: string): Promise<AutomatedReasoningPolicyTestResult[]> {
    const allResults: AutomatedReasoningPolicyTestResult[] = [];
    let nextToken: string | undefined;
    do {
      const res = await this.client.send(
        new ListAutomatedReasoningPolicyTestResultsCommand({
          policyArn,
          buildWorkflowId,
          maxResults: 100,
          ...(nextToken && { nextToken }),
        })
      );
      allResults.push(...(res.testResults ?? []));
      nextToken = res.nextToken;
    } while (nextToken);
    return allResults;
  }

  /**
   * Load all test cases and merge them with their latest results for a build.
   * Tests that haven't been run yet will have no result fields populated.
   */
  async loadTestsWithResults(
    policyArn: string,
    buildWorkflowId: string
  ): Promise<TestCaseWithResult[]> {
    const [testCases, testResults] = await Promise.all([
      this.listTestCases(policyArn),
      this.listTestResults(policyArn, buildWorkflowId),
    ]);

    const resultsByTestId = new Map<string, AutomatedReasoningPolicyTestResult>();
    for (const r of testResults) {
      if (r.testCase?.testCaseId) {
        resultsByTestId.set(r.testCase.testCaseId, r);
      }
    }

    return testCases.map((tc) => {
      const result = resultsByTestId.get(tc.testCaseId!); // guaranteed by API contract
      return mergeTestCaseWithResult(tc, result);
    });
  }

  /**
   * Execute a single test case against a build and poll until complete.
   * Returns the merged test case with its updated result.
   */
  async executeTestCase(
    policyArn: string,
    buildWorkflowId: string,
    testCaseId: string,
    intervalMs = 2000,
    maxAttempts = 60
  ): Promise<TestCaseWithResult> {
    await this.client.send(
      new StartAutomatedReasoningPolicyTestWorkflowCommand({
        policyArn,
        buildWorkflowId,
        testCaseIds: [testCaseId],
      })
    );

    // Poll the test result until it reaches a terminal status
    const res = await pollUntil(
      () => this.getTestResult(policyArn, buildWorkflowId, testCaseId),
      (res) => {
        const result = res.testResult;
        return !!result && !ACTIVE_TEST_STATUSES.has(result.testRunStatus!);
      },
      { intervalMs, maxAttempts },
      `test ${testCaseId}`,
    );
    return mergeTestCaseWithResult(res.testResult!.testCase!, res.testResult!);
  }

  /**
   * Poll until all tests for a build reach a terminal status.
   * Returns the merged test cases with results.
   */
  async pollTestCompletion(
      policyArn: string,
      buildWorkflowId: string,
      intervalMs = 3000,
      maxAttempts = 100
    ): Promise<TestCaseWithResult[]> {
      try {
        const results = await pollUntil(
          () => this.loadTestsWithResults(policyArn, buildWorkflowId),
          (results) => {
            const pending = results.filter((t) => ACTIVE_TEST_STATUSES.has(t.testRunStatus ?? "NOT_STARTED"));
            return pending.length === 0;
          },
          { intervalMs, maxAttempts },
          `tests for build ${buildWorkflowId}`,
        );
        this.emitTestsExecuted(policyArn, buildWorkflowId);
        return results;
      } catch (err) {
        if (err instanceof GenericPollTimeoutError) {
          // Return whatever we have even if some tests are still pending
          const results = await this.loadTestsWithResults(policyArn, buildWorkflowId);
          this.emitTestsExecuted(policyArn, buildWorkflowId);
          return results;
        }
        throw err;
      }
    }

}