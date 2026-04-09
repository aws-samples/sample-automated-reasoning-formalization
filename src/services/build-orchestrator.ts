/**
 * Build asset loading, fidelity report management, and background polling.
 *
 * Extracted from renderer.ts — owns all build-related orchestration that
 * was previously in the composition root. Uses callback-based dependency
 * injection for UI interactions so it remains testable.
 */
import type { PolicyService, BuildWorkflowInfo } from "./policy-service";
import { ACTIVE_BUILD_STATUSES } from "./policy-service";
import { buildAssetsStore } from "./build-assets-store";
import type { BuildAssets, FidelityReport, PolicyMetadata, PolicyLocalState, TestCaseWithResult, PolicyDefinition } from "../types";
import { toAppDefinition } from "../utils/policy-definition";
import type { AutomatedReasoningPolicyDefinition } from "@aws-sdk/client-bedrock";
import { parseFidelityAsset } from "../utils/fidelity";
import { runFidelityBuildWorkflow } from "./fidelity-workflow";
import { parseScenariosAsset, selectScenarios } from "../utils/scenarios";
import { parseBuildLogAsset } from "../utils/build-log";
import { withTimeout } from "../utils/async";

import type { PolicyStateAccessor } from "../state/policy-state";

// ── UI callback interfaces ──

export interface BuildOrchestratorUI {
  /** Show/hide loading state on the document preview panel. */
  docSetLoading(loading: boolean, message?: string): void;
  /** Apply fidelity report highlights to the document preview. */
  docSetHighlights(report: FidelityReport): void;
  /** Show/hide the regenerate fidelity report button. */
  docSetRegenerateVisible(visible: boolean): void;
  /** Show/hide the stale fidelity report banner in the document preview. */
  docSetStaleBanner(visible: boolean): void;
  /** Show/hide loading state on the test panel. */
  testSetLoading(loading: boolean, message?: string): void;
  /** Load test results into the test panel. */
  testLoadTests(results: TestCaseWithResult[]): void;
  /** Append a status message to the chat panel. Returns the element for updates. */
  chatAppendStatus(text: string): HTMLElement;
}

export interface BuildOrchestratorState extends Pick<PolicyStateAccessor,
  | 'getPolicy' | 'getLocalState' | 'getDefinition'
  | 'getBuildWorkflowId' | 'setBuildWorkflowId'
  | 'setTestCases' | 'setTestsWithResults'
  | 'getSourceDocumentText' | 'persistLocalState'
> {
  saveFidelityReport(policyArn: string, buildWorkflowId: string, json: string): Promise<void>;
  saveScenarios(policyArn: string, json: string): Promise<void>;
}

// ── Build Orchestrator ──

export class BuildOrchestrator {
  constructor(
    private policyService: PolicyService,
    private ui: BuildOrchestratorUI,
    private state: BuildOrchestratorState,
  ) {}

  /** Track active polling intervals so they can be cleared on policy switch. */
  private activePollingIntervals = new Set<ReturnType<typeof setInterval>>();

  /** Stop all active background polling intervals. */
  clearAllPollingIntervals(): void {
    for (const id of this.activePollingIntervals) clearInterval(id);
    this.activePollingIntervals.clear();
  }

  /**
   * Fetch all build workflow assets (definition, build log, quality report)
   * and populate the global buildAssetsStore.
   */
  async loadBuildAssets(policyArn: string, buildWorkflowId: string): Promise<void> {
    console.log("[loadBuildAssets] Fetching assets for build:", buildWorkflowId);
    const assets: BuildAssets = {
      buildWorkflowId,
      policyDefinition: null, rawPolicyDefinition: null,
      buildLog: null, rawBuildLog: null,
      qualityReport: null, rawQualityReport: null,
      fidelityReport: null, rawFidelityReport: null,
      policyScenarios: null, rawPolicyScenarios: null,
    };

    const [defResult, logResult, qualityResult, fidelityResult, scenariosResult] = await Promise.allSettled([
      this.policyService.getBuildAssets(policyArn, buildWorkflowId, "POLICY_DEFINITION"),
      this.policyService.getBuildAssets(policyArn, buildWorkflowId, "BUILD_LOG"),
      this.policyService.getBuildAssets(policyArn, buildWorkflowId, "QUALITY_REPORT"),
      this.policyService.getBuildAssets(policyArn, buildWorkflowId, "FIDELITY_REPORT"),
      this.policyService.getBuildAssets(policyArn, buildWorkflowId, "POLICY_SCENARIOS"),
    ]);

    if (defResult.status === "fulfilled" && defResult.value) {
      assets.rawPolicyDefinition = defResult.value;
      if ("policyDefinition" in defResult.value && defResult.value.policyDefinition) {
        assets.policyDefinition = toAppDefinition(defResult.value.policyDefinition);
      }
    }
    if (logResult.status === "fulfilled" && logResult.value) {
      assets.rawBuildLog = logResult.value;
      assets.buildLog = parseBuildLogAsset(logResult.value);
    }
    if (qualityResult.status === "fulfilled" && qualityResult.value) {
      assets.rawQualityReport = qualityResult.value;
      try {
        if ("qualityReport" in qualityResult.value && qualityResult.value.qualityReport) {
          const qr = qualityResult.value.qualityReport;
          // Map SDK quality report structure to app QualityReportIssue[]
          const issues: import("../types").QualityReportIssue[] = [];
          if (qr.unusedVariables?.length) issues.push({ issueType: "unused_variables", description: `Unused variables: ${qr.unusedVariables.join(", ")}`, affectedIds: qr.unusedVariables });
          if (qr.unusedTypes?.length) issues.push({ issueType: "unused_type_values", description: `Unused types: ${qr.unusedTypes.join(", ")}`, affectedIds: qr.unusedTypes });
          if (qr.conflictingRules?.length) issues.push({ issueType: "conflicting_rules", description: `Conflicting rules: ${qr.conflictingRules.join(", ")}`, affectedIds: qr.conflictingRules });
          if (qr.disjointRuleSets?.length) issues.push({ issueType: "disjoint_rule_sets", description: `Found ${qr.disjointRuleSets.length} disjoint rule set(s)` });
          if (issues.length > 0) assets.qualityReport = issues;
        }
      } catch { /* Quality report parsing is best-effort; a malformed report does not block build asset loading */ }
    }
    if (fidelityResult.status === "fulfilled" && fidelityResult.value) {
      assets.rawFidelityReport = fidelityResult.value;
      assets.fidelityReport = parseFidelityAsset(fidelityResult.value);
    }
    if (scenariosResult.status === "fulfilled" && scenariosResult.value) {
      assets.rawPolicyScenarios = scenariosResult.value;
      const allScenarios = parseScenariosAsset(scenariosResult.value);
      assets.policyScenarios = selectScenarios(allScenarios);
      console.log("[loadBuildAssets] Selected", assets.policyScenarios.length, "scenarios from", allScenarios.length, "total");
    }

    // Fallback: restore from cached local state
    const localState = this.state.getLocalState();
    if (!assets.fidelityReport && localState?.fidelityReports?.[buildWorkflowId]) {
      assets.fidelityReport = localState.fidelityReports[buildWorkflowId];
      // rawFidelityReport stays null — this is a cached app-level report, not a raw SDK asset
      console.log("[loadBuildAssets] Restored cached fidelity report for build:", buildWorkflowId);
    }

    buildAssetsStore.set(assets);
    console.log("[loadBuildAssets] Assets stored — definition:", !!assets.policyDefinition,
      "buildLog:", !!assets.buildLog, "qualityReport:", !!assets.qualityReport,
      "fidelityReport:", !!assets.fidelityReport, "policyScenarios:", !!assets.policyScenarios);

    // Persist scenarios to local storage
    if (assets.policyScenarios && assets.policyScenarios.length > 0) {
      await this.saveScenariosToLocalState(buildWorkflowId, assets.policyScenarios);
    }
  }

  /**
   * Poll any in-progress build workflows and update the relevant panels.
   */
  async pollBackgroundWorkflows(policyArn: string, skipBuildTypes?: ReadonlySet<string>): Promise<void> {
    let builds: BuildWorkflowInfo[];
    try {
      builds = await this.policyService.listBuilds(policyArn);
    } catch (err) {
      console.warn("[pollBackgroundWorkflows] Failed to list builds:", (err as Error).message);
      return;
    }

    const inProgress = builds.filter((b) =>
      ACTIVE_BUILD_STATUSES.has(b.status) && !skipBuildTypes?.has(b.buildWorkflowType),
    );
    if (inProgress.length === 0) {
      console.log("[pollBackgroundWorkflows] No in-progress builds");
      return;
    }

    console.log("[pollBackgroundWorkflows] Found", inProgress.length, "in-progress build(s)");
    const POLL_INTERVAL_MS = 5_000;

    for (const build of inProgress) {
      const isFidelity = build.buildWorkflowType === "GENERATE_FIDELITY_REPORT";
      if (isFidelity) this.ui.docSetLoading(true, "Generating grounding report…");
      else this.ui.testSetLoading(true, "Generating tests…");

      const intervalId = setInterval(async () => {
        try {
          const status = await this.policyService.getBuild(policyArn, build.buildWorkflowId);
          const done = !ACTIVE_BUILD_STATUSES.has(status.status);

          if (!isFidelity && this.state.getBuildWorkflowId()) {
            try {
              const results = await this.policyService.loadTestsWithResults(policyArn, this.state.getBuildWorkflowId()!);
              this.ui.testLoadTests(results);
              this.state.setTestsWithResults(results);
              this.state.setTestCases(results);
            } catch (err) { console.warn("[pollBackgroundWorkflows] Incremental test refresh failed:", (err as Error).message); }
          }

          if (!done) return;

          clearInterval(intervalId);
          this.activePollingIntervals.delete(intervalId);
          console.log("[pollBackgroundWorkflows] Build", build.buildWorkflowId, "(", build.buildWorkflowType, ") finished with status:", status.status);

          if (status.status !== "COMPLETED") {
            if (isFidelity) this.ui.docSetLoading(false);
            else this.ui.testSetLoading(false);
            return;
          }

          if (isFidelity) {
            try {
              const fidelityAsset = await this.policyService.getBuildAssets(policyArn, build.buildWorkflowId, "FIDELITY_REPORT");
              const typedReport = parseFidelityAsset(fidelityAsset);
              if (typedReport) {
                const assets = buildAssetsStore.get();
                if (assets) { assets.fidelityReport = typedReport; assets.rawFidelityReport = fidelityAsset ?? null; buildAssetsStore.set(assets); }
                this.ui.docSetHighlights(typedReport);
                await this.saveFidelityReportToMetadata(build.buildWorkflowId, typedReport);
                console.log("[pollBackgroundWorkflows] Fidelity report applied");
              }
            } catch (err) { console.warn("[pollBackgroundWorkflows] Fidelity asset load failed:", (err as Error).message); }
            this.ui.docSetLoading(false);
            this.ui.docSetRegenerateVisible(true);
          } else {
            try { await this.policyService.getBuildAssets(policyArn, build.buildWorkflowId, "GENERATED_TEST_CASES"); } catch { /* Pre-fetching generated test cases is non-critical; tests are loaded separately below */ }
            if (this.state.getBuildWorkflowId()) {
              try {
                const results = await this.policyService.loadTestsWithResults(policyArn, this.state.getBuildWorkflowId()!);
                this.ui.testLoadTests(results);
                this.state.setTestsWithResults(results);
                this.state.setTestCases(results);
              } catch (err) { console.warn("[pollBackgroundWorkflows] Final test load failed:", (err as Error).message); }
            }
            this.ui.testSetLoading(false);
          }
        } catch (err) { console.warn("[pollBackgroundWorkflows] Poll tick failed:", (err as Error).message); }
      }, POLL_INTERVAL_MS);

      this.activePollingIntervals.add(intervalId);
    }
  }

  /**
   * Apply fidelity report highlights to the document preview.
   * If no API-provided fidelity report exists, returns false so the caller
   * can prompt the user to generate one (instead of auto-starting a build).
   */
  async applyFidelityReport(): Promise<boolean> {
    const assets = buildAssetsStore.get();

    if (assets?.fidelityReport) {
      console.log("[applyFidelityReport] Using API-provided fidelity report");
      this.ui.docSetHighlights(assets.fidelityReport);
      this.ui.docSetLoading(false);
      this.ui.docSetRegenerateVisible(true);
      await this.saveFidelityReportToMetadata(assets.buildWorkflowId, assets.fidelityReport);
      return true;
    }

    const policy = this.state.getPolicy();
    const definition = this.state.getDefinition();
    if (!policy || !definition) {
      console.log("[applyFidelityReport] No policy or definition — skipping");
      return false;
    }

    console.log("[applyFidelityReport] No fidelity report available — deferring to user");
    this.ui.docSetRegenerateVisible(true);
    return false;
  }

  /**
   * Start a GENERATE_FIDELITY_REPORT build, poll until complete, and apply the result.
   * Used when the user explicitly requests (re)generation.
   */
  async generateFidelityReport(): Promise<void> {
    const policy = this.state.getPolicy();
    if (!policy) {
      console.log("[generateFidelityReport] No policy — skipping");
      return;
    }

    // Always export the latest definition from the service to avoid stale state
    let definition: AutomatedReasoningPolicyDefinition;
    try {
      definition = await this.policyService.exportPolicyDefinition(policy.policyArn);
    } catch (err) {
      console.warn("[generateFidelityReport] Failed to export latest definition:", (err as Error).message);
      const fallback = this.state.getDefinition();
      if (!fallback) {
        console.log("[generateFidelityReport] No definition available — skipping");
        return;
      }
      definition = fallback;
    }

    console.log("[generateFidelityReport] Starting GENERATE_FIDELITY_REPORT workflow...");
    this.ui.docSetLoading(true, "Generating grounding report…");
    this.ui.docSetRegenerateVisible(false);
    const statusEl = this.ui.chatAppendStatus("Generating grounding report...");

    try {
      statusEl.textContent = "Generating grounding report — this may take a moment...";

      const result = await runFidelityBuildWorkflow(
        this.policyService,
        policy.policyArn,
        definition,
        this.state.getSourceDocumentText() ?? undefined,
        { onProgress: (msg) => { statusEl.textContent = msg; } },
      );

      const assets = buildAssetsStore.get();
      if (assets) {
        assets.fidelityReport = result.report;
        assets.rawFidelityReport = result.rawAsset ?? null;
        buildAssetsStore.set(assets);
      }
      this.ui.docSetHighlights(result.report);
      await this.saveFidelityReportToMetadata(result.buildWorkflowId, result.report);
      statusEl.textContent = "Grounding report generated.";
      console.log("[generateFidelityReport] Fidelity report applied from new build:", result.buildWorkflowId);
      this.ui.docSetLoading(false);
      this.ui.docSetRegenerateVisible(true);
    } catch (err) {
      const msg = (err as Error).message;
      console.warn("[generateFidelityReport] Fidelity report generation failed:", msg);
      if ((err as Error).name === "PollTimeoutError") {
        statusEl.textContent = "Grounding report is still generating…";
        console.warn("[generateFidelityReport] Polling timed out — background poller will continue");
        return;
      }
      statusEl.textContent = "Could not generate grounding report.";
      this.ui.docSetLoading(true, "Grounding report failed — try again from the chat.");
      setTimeout(() => { this.ui.docSetLoading(false); this.ui.docSetRegenerateVisible(true); }, 5000);
    }
  }

  /**
   * Persist a fidelity report in local state, keyed by build workflow ID.
   */
  async saveFidelityReportToMetadata(buildWorkflowId: string, report: FidelityReport): Promise<void> {
    const policy = this.state.getPolicy();
    if (!policy) return;
    const localState = this.state.getLocalState();
    if (localState) {
      localState.fidelityReports[buildWorkflowId] = report;
      localState.lastFidelityBuildWorkflowId = buildWorkflowId;
      localState.lastFidelityReportTimestamp = Date.now();
      try { await this.state.saveFidelityReport(policy.policyArn, buildWorkflowId, JSON.stringify(report)); } catch { /* Fidelity report disk persistence is best-effort; the in-memory local state is already updated */ }
      await this.state.persistLocalState();
      console.log("[saveFidelityReport] Saved fidelity report for build:", buildWorkflowId);
    }
  }

  /**
   * Persist curated policy scenarios in local state, keyed by build workflow ID.
   */
  async saveScenariosToLocalState(buildWorkflowId: string, scenarios: import("../types").PolicyScenario[]): Promise<void> {
    const policy = this.state.getPolicy();
    if (!policy) return;
    const localState = this.state.getLocalState();
    if (localState) {
      localState.policyScenarios = scenarios;
      localState.lastScenariosBuildWorkflowId = buildWorkflowId;
      try { await this.state.saveScenarios(policy.policyArn, JSON.stringify(scenarios)); } catch { /* Scenario disk persistence is best-effort; the in-memory local state is already updated */ }
      await this.state.persistLocalState();
      console.log("[saveScenariosToLocalState] Saved", scenarios.length, "scenarios for build:", buildWorkflowId);
    }
  }

  /**
   * Find the latest completed build for a policy and load its assets.
   */
  async loadLatestBuildAssets(policyArn: string): Promise<{ staleFidelityReport: boolean; fidelityBuildInProgress: boolean }> {
    console.log("[loadLatestBuildAssets] Listing builds...");
    const builds = await withTimeout(this.policyService.listBuilds(policyArn), 15_000, "listBuilds");
    console.log("[loadLatestBuildAssets] Found", builds.length, "builds");

    const completed = this.policyService.findLatestPolicyBuild(builds);
    if (!completed) {
      console.log("[loadLatestBuildAssets] No completed policy build found");
      return { staleFidelityReport: false, fidelityBuildInProgress: false };
    }

    console.log("[loadLatestBuildAssets] Loading assets for completed build:", completed.buildWorkflowId);
    this.state.setBuildWorkflowId(completed.buildWorkflowId);
    await withTimeout(this.loadBuildAssets(policyArn, completed.buildWorkflowId), 30_000, "loadBuildAssets");

    // Restore cached scenarios if the API didn't return them
    const assets = buildAssetsStore.get();
    if (assets && !assets.policyScenarios) {
      const localState = this.state.getLocalState();
      if (localState?.policyScenarios) {
        assets.policyScenarios = localState.policyScenarios;
        buildAssetsStore.set(assets);
        console.log("[loadLatestBuildAssets] Restored cached scenarios");
      }
    }
    if (!assets) {
      return { staleFidelityReport: false, fidelityBuildInProgress: false };
    }

    return this.resolveFidelityReport(policyArn, builds, assets, completed);
  }

  /**
   * Resolve the best available fidelity report from any source.
   *
   * Tries, in order:
   *   1. A standalone fidelity build newer than the policy build (cached or remote)
   *   2. The fidelity report bundled with the policy build assets
   *   3. An in-progress fidelity build (poll and wait)
   *   4. Any older completed fidelity build
   */
  private async resolveFidelityReport(
    policyArn: string,
    builds: BuildWorkflowInfo[],
    assets: BuildAssets,
    latestPolicyBuild: BuildWorkflowInfo,
  ): Promise<{ staleFidelityReport: boolean; fidelityBuildInProgress: boolean }> {
    // ── Try newer standalone fidelity build ──
    const resolved = await this.tryNewerFidelityBuild(policyArn, builds, assets, latestPolicyBuild);
    if (resolved) return resolved;

    // ── Use bundled fidelity report if present ──
    if (assets.fidelityReport) {
      return { staleFidelityReport: this.isFidelityReportStale(latestPolicyBuild), fidelityBuildInProgress: false };
    }

    // ── Wait for in-progress fidelity build ──
    const inProgressResult = await this.tryInProgressFidelityBuild(policyArn, builds, assets);
    if (inProgressResult) return inProgressResult;

    // ── Fall back to any older completed fidelity build ──
    await this.tryOlderFidelityBuilds(policyArn, builds, assets, latestPolicyBuild);

    if (assets.fidelityReport) {
      return { staleFidelityReport: this.isFidelityReportStale(latestPolicyBuild), fidelityBuildInProgress: false };
    }
    return { staleFidelityReport: false, fidelityBuildInProgress: false };
  }

  /**
   * Check if a standalone fidelity build is newer than the policy build.
   * If so, apply it from cache or fetch it from the API.
   * Returns a result if resolved, or null to continue to the next strategy.
   */
  private async tryNewerFidelityBuild(
    policyArn: string,
    builds: BuildWorkflowInfo[],
    assets: BuildAssets,
    latestPolicyBuild: BuildWorkflowInfo,
  ): Promise<{ staleFidelityReport: boolean; fidelityBuildInProgress: boolean } | null> {
    const localState = this.state.getLocalState();
    const cachedBuildId = localState?.lastFidelityBuildWorkflowId;

    const completedFidelityBuilds = builds.filter(
      (b) => b.buildWorkflowType === "GENERATE_FIDELITY_REPORT" && b.status === "COMPLETED"
    );
    completedFidelityBuilds.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    const latestFidelityBuild = completedFidelityBuilds[0];

    if (!latestFidelityBuild) return null;
    if (assets.fidelityReport && latestFidelityBuild.updatedAt.getTime() <= latestPolicyBuild.updatedAt.getTime()) return null;

    // Try local cache first
    if (cachedBuildId && latestFidelityBuild.buildWorkflowId === cachedBuildId) {
      const cachedReport = localState?.fidelityReports?.[cachedBuildId];
      if (cachedReport) {
        console.log("[resolveFidelity] Cached fidelity report is current, applying directly");
        assets.fidelityReport = cachedReport;
        buildAssetsStore.set(assets);
        return { staleFidelityReport: this.isFidelityReportStale(latestPolicyBuild), fidelityBuildInProgress: false };
      }
    }

    // Fetch from API
    if (!cachedBuildId || latestFidelityBuild.buildWorkflowId !== cachedBuildId) {
      console.log("[resolveFidelity] Remote fidelity report is newer, fetching:", latestFidelityBuild.buildWorkflowId);
      try {
        const fidelityAsset = await this.policyService.getBuildAssets(policyArn, latestFidelityBuild.buildWorkflowId, "FIDELITY_REPORT");
        const typedReport = parseFidelityAsset(fidelityAsset);
        if (typedReport) {
          assets.fidelityReport = typedReport;
          assets.rawFidelityReport = fidelityAsset ?? null;
          buildAssetsStore.set(assets);
          await this.saveFidelityReportToMetadata(latestFidelityBuild.buildWorkflowId, typedReport);
          console.log("[resolveFidelity] Applied fresher fidelity report from build:", latestFidelityBuild.buildWorkflowId);
          return { staleFidelityReport: this.isFidelityReportStale(latestPolicyBuild), fidelityBuildInProgress: false };
        }
      } catch (err) {
        console.warn("[resolveFidelity] Failed to fetch fresher fidelity report:", (err as Error).message);
      }
    }

    return null;
  }

  /**
   * If a fidelity build is currently in progress, poll it and apply the result.
   * Returns a result if resolved, or null to continue to the next strategy.
   */
  private async tryInProgressFidelityBuild(
    policyArn: string,
    builds: BuildWorkflowInfo[],
    assets: BuildAssets,
  ): Promise<{ staleFidelityReport: boolean; fidelityBuildInProgress: boolean } | null> {
    const inProgressFidelity = builds.find(
      (b) => b.buildWorkflowType === "GENERATE_FIDELITY_REPORT" && b.status !== "COMPLETED" && b.status !== "FAILED" && b.status !== "CANCELLED"
    );
    if (!inProgressFidelity) return null;

    console.log("[resolveFidelity] Fidelity report build in progress:", inProgressFidelity.buildWorkflowId);
    this.ui.docSetLoading(true, "Generating grounding report…");
    this.ui.chatAppendStatus("Waiting for fidelity report generation...");
    try {
      const result = await this.policyService.pollBuild(policyArn, inProgressFidelity.buildWorkflowId);
      if (result.status === "COMPLETED") {
        const fidelityAsset = await this.policyService.getBuildAssets(policyArn, inProgressFidelity.buildWorkflowId, "FIDELITY_REPORT");
        const typedReport = parseFidelityAsset(fidelityAsset);
        if (typedReport) {
          assets.fidelityReport = typedReport;
          assets.rawFidelityReport = fidelityAsset ?? null;
          buildAssetsStore.set(assets);
          console.log("[resolveFidelity] Fidelity report merged from in-progress build");
          this.ui.docSetLoading(false);
          return { staleFidelityReport: false, fidelityBuildInProgress: false };
        }
      } else {
        console.warn("[resolveFidelity] Fidelity report build ended with status:", result.status);
      }
      this.ui.docSetLoading(false);
    } catch (err) {
      const errMsg = (err as Error).message;
      console.warn("[resolveFidelity] Fidelity report polling failed:", errMsg);
      if (errMsg.includes("timed out")) {
        console.log("[resolveFidelity] Polling timed out — deferring to background poller");
        return { staleFidelityReport: false, fidelityBuildInProgress: true };
      }
      this.ui.docSetLoading(false);
    }
    return null;
  }

  /**
   * Search older completed fidelity builds for a usable report.
   * Mutates `assets.fidelityReport` in place if found.
   */
  private async tryOlderFidelityBuilds(
    policyArn: string,
    builds: BuildWorkflowInfo[],
    assets: BuildAssets,
    latestPolicyBuild: BuildWorkflowInfo,
  ): Promise<void> {
    const olderFidelityBuilds = builds.filter(
      (b) => b.buildWorkflowType === "GENERATE_FIDELITY_REPORT" && b.status === "COMPLETED"
    );
    for (const olderBuild of olderFidelityBuilds) {
      console.log("[resolveFidelity] Trying older fidelity build:", olderBuild.buildWorkflowId);
      try {
        const fidelityAsset = await this.policyService.getBuildAssets(policyArn, olderBuild.buildWorkflowId, "FIDELITY_REPORT");
        const typedReport = parseFidelityAsset(fidelityAsset);
        if (typedReport) {
          assets.fidelityReport = typedReport;
          assets.rawFidelityReport = fidelityAsset ?? null;
          buildAssetsStore.set(assets);
          await this.saveFidelityReportToMetadata(olderBuild.buildWorkflowId, typedReport);
          console.log("[resolveFidelity] Loaded older fidelity report from build:", olderBuild.buildWorkflowId);
          return;
        }
      } catch (err) {
        console.warn("[resolveFidelity] Failed to fetch fidelity report from older build:", olderBuild.buildWorkflowId, (err as Error).message);
      }
    }
  }

  /**
   * Check whether the fidelity report is stale by comparing the saved
   * fidelity report timestamp against the latest completed policy build.
   * If the policy build finished after the fidelity report was generated,
   * the report doesn't reflect the latest policy changes.
   */
  private isFidelityReportStale(latestPolicyBuild: BuildWorkflowInfo): boolean {
    const localState = this.state.getLocalState();
    const fidelityTimestamp = localState?.lastFidelityReportTimestamp;
    if (!fidelityTimestamp) {
      // No timestamp recorded — treat as stale if there's a policy build
      // (the report predates the timestamp tracking)
      return true;
    }
    const isStale = latestPolicyBuild.updatedAt.getTime() > fidelityTimestamp;
    if (isStale) {
      console.log("[isFidelityReportStale] Policy build", latestPolicyBuild.buildWorkflowId,
        "completed at", latestPolicyBuild.updatedAt.toISOString(),
        "which is after fidelity report timestamp", new Date(fidelityTimestamp).toISOString());
    }
    return isStale;
  }
}
