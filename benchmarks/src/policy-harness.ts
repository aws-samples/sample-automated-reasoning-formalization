/**
 * Policy harness — creates, seeds, and tears down ephemeral benchmark policies.
 *
 * Uses PolicyService directly (no agent involvement). The fixture's policy
 * definition is written to the DRAFT, then an INGEST_CONTENT build is triggered
 * to make the definition available for test execution.
 */
import type { PolicyService } from "../../src/services/policy-service";
import type { BenchmarkFixture, BenchmarkPolicy } from "./types";

/**
 * Delete all test cases, builds, and the policy itself.
 * Order matters: test cases first, then builds, then the policy.
 * Each step is best-effort so partial cleanup still progresses.
 */
export async function deletePolicy(
  policyService: PolicyService,
  policyArn: string,
  log: (msg: string) => void,
): Promise<void> {
  // 1. Delete test cases
  try {
    const testCases = await policyService.listTestCases(policyArn);
    for (const tc of testCases) {
      if (tc.testCaseId) {
        await policyService.deleteTestCase(policyArn, tc.testCaseId, tc.updatedAt!);
      }
    }
    log(`  Deleted ${testCases.length} test case(s).`);
  } catch (err) {
    log(`  Warning: test case cleanup failed: ${(err as Error).message}`);
  }

  // 2. Delete all builds
  try {
    const builds = await policyService.listBuilds(policyArn);
    for (const b of builds) {
      await policyService.deleteBuild(policyArn, b.buildWorkflowId, b.updatedAt);
    }
    log(`  Deleted ${builds.length} build(s).`);
  } catch (err) {
    log(`  Warning: build cleanup failed: ${(err as Error).message}`);
  }

  // 3. Delete the policy
  await policyService.deletePolicy(policyArn);
  log("  Policy deleted.");
}

export async function createBenchmarkPolicy(
  policyService: PolicyService,
  fixture: BenchmarkFixture,
  log: (msg: string) => void,
): Promise<BenchmarkPolicy> {
  const name = `benchmark-${Date.now()}`;
  log(`Creating ephemeral policy "${name}"…`);
  const policyArn = await policyService.createPolicy(name);
  log(`Policy created: ${policyArn}`);

  try {
    // Seed the policy using IMPORT_POLICY build workflow.
    // This imports the definition directly without processing any natural language.
    log("Starting IMPORT_POLICY build…");
    const def = fixture.policyDefinition as any;
    const buildId = await policyService.startBuild(
      policyArn,
      "IMPORT_POLICY" as any,
      { policyDefinition: def } as any,
    );

    log(`Build started: ${buildId}. Polling for completion (up to 15 min)…`);
    const build = await policyService.pollBuild(policyArn, buildId, 5000, 180);
    log(`Build finished with status: ${build.status}`);
    if (build.status !== "COMPLETED") {
      try {
        const buildInfo = await policyService.getBuild(policyArn, buildId);
        log(`Build info: ${JSON.stringify(buildInfo)}`);
      } catch (e) {
        log(`Failed to fetch build info: ${(e as Error).message}`);
      }
      for (const assetType of ["BUILD_LOG", "POLICY_DEFINITION", "ASSET_MANIFEST"] as const) {
        try {
          const asset = await policyService.getBuildAssets(policyArn, buildId, assetType);
          log(`Asset ${assetType}: ${JSON.stringify(asset).slice(0, 3000)}`);
        } catch (e) {
          log(`Asset ${assetType}: not available (${(e as Error).message})`);
        }
      }
      throw new Error(`Initial build failed with status: ${build.status}`);
    }
    log("Build completed.");

    // The build produces the compiled definition as an asset, but doesn't
    // automatically apply it to the DRAFT. Fetch the output and update.
    log("Fetching build output and applying to DRAFT…");
    const buildDefAsset = await policyService.getBuildAssets(policyArn, buildId, "POLICY_DEFINITION");
    const buildDef = (buildDefAsset as any)?.policyDefinition;
    if (buildDef) {
      await policyService.updatePolicy(policyArn, buildDef);
      log(`  Applied build output: ${buildDef.rules?.length ?? 0} rules, ${buildDef.variables?.length ?? 0} variables`);
    } else {
      // Fallback: apply the original fixture definition directly
      log("  No build output — applying fixture definition directly.");
      await policyService.updatePolicy(policyArn, def);
    }

    // Export the definition to confirm it was applied
    const builtDef = await policyService.exportPolicyDefinition(policyArn);
    log(`  Confirmed: ${(builtDef as any).rules?.length ?? 0} rules, ${(builtDef as any).variables?.length ?? 0} variables`);

    // Create test cases
    log(`Creating ${fixture.tests.length} test cases…`);
    const testIdMap = new Map<string, string>();
    const testCaseIds: string[] = [];
    for (const test of fixture.tests) {
      const tcId = await policyService.createTestCase(
        policyArn,
        test.guardContent,
        test.queryContent,
        test.expectedResult as any,
      );
      testIdMap.set(test.id, tcId);
      testCaseIds.push(tcId);
      log(`  Created test "${test.id}" → ${tcId}`);
    }

    const cleanup = async () => {
      log("Cleaning up ephemeral policy…");
      await deletePolicy(policyService, policyArn, log);
    };

    return {
      policyArn,
      testCaseIds,
      testIdMap,
      policyDefinition: builtDef as unknown as Record<string, unknown>,
      cleanup,
    };
  } catch (err) {
    // If setup fails, try to clean up the policy we created
    log(`Setup failed: ${(err as Error).message}. Cleaning up…`);
    try { await deletePolicy(policyService, policyArn, log); } catch { /* best effort */ }
    throw err;
  }
}
