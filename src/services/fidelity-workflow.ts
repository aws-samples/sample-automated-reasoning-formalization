/**
 * Shared fidelity report build workflow.
 *
 * Encapsulates the core steps for generating a fidelity report:
 * export definition → ensure build slot → start build → poll → fetch asset → parse.
 *
 * Used by both BuildOrchestrator (UI-facing) and PolicyWorkflowService (MCP-facing)
 * so the workflow logic isn't duplicated across the two orchestration layers.
 */
import type { PolicyService, BuildWorkflowInfo } from "./policy-service";
import type { FidelityReport } from "../types";
import type { AutomatedReasoningPolicyDefinition, AutomatedReasoningPolicyBuildResultAssets } from "@aws-sdk/client-bedrock";
import { parseFidelityAsset } from "../utils/fidelity";

export interface FidelityBuildResult {
  buildWorkflowId: string;
  report: FidelityReport;
  /** Raw asset from the API (for store population). */
  rawAsset: AutomatedReasoningPolicyBuildResultAssets | null;
}

export interface FidelityWorkflowOptions {
  /** Called at each step for progress visibility. */
  onProgress?: (message: string) => void;
  /** Poll interval in ms (default: 5000). */
  pollIntervalMs?: number;
  /** Max poll attempts (default: 60). */
  pollMaxAttempts?: number;
}

/**
 * Run the fidelity report build workflow end-to-end.
 *
 * 1. Ensure a build slot is available
 * 2. Start the GENERATE_FIDELITY_REPORT build
 * 3. Poll until completion
 * 4. Fetch and parse the fidelity report asset
 *
 * Throws on build failure, poll timeout, or missing report asset.
 * The caller is responsible for UI updates, store population, and cleanup.
 */
export async function runFidelityBuildWorkflow(
  policyService: PolicyService,
  policyArn: string,
  definition: AutomatedReasoningPolicyDefinition,
  sourceDocumentText?: string,
  options: FidelityWorkflowOptions = {},
): Promise<FidelityBuildResult> {
  const { onProgress, pollIntervalMs = 5_000, pollMaxAttempts = 60 } = options;

  onProgress?.("Cleaning up old builds…");
  try {
    await policyService.manageBuildSlot(policyArn, "GENERATE_FIDELITY_REPORT");
  } catch (err) {
    console.warn("[fidelityWorkflow] Build slot cleanup failed (non-critical):", (err as Error).message);
  }

  onProgress?.("Starting fidelity report generation…");
  const buildId = await policyService.startFidelityReportBuild(policyArn, definition, sourceDocumentText);

  onProgress?.("Building fidelity report — this may take a minute…");
  const build = await policyService.pollBuild(policyArn, buildId, pollIntervalMs, pollMaxAttempts);

  if (build.status !== "COMPLETED") {
    throw new Error(`Fidelity report build ended with status: ${build.status}`);
  }

  onProgress?.("Retrieving fidelity report…");
  const asset = await policyService.getBuildAssets(policyArn, build.buildWorkflowId, "FIDELITY_REPORT");
  const report = parseFidelityAsset(asset);
  if (!report) {
    throw new Error("Fidelity report build completed but no valid report asset found");
  }

  return { buildWorkflowId: build.buildWorkflowId, report, rawAsset: asset ?? null };
}
