#!/usr/bin/env npx tsx
/**
 * Cleanup script — finds and deletes orphaned benchmark policies.
 *
 * Policies created by the benchmark are named "benchmark-<timestamp>".
 * If the benchmark crashes without running teardown, these policies
 * remain in the account. This script finds and deletes them.
 *
 * Usage: npm run benchmark:cleanup
 */
import { fromIni } from "@aws-sdk/credential-providers";
import { PolicyService } from "../../src/services/policy-service";
import { deletePolicy } from "./policy-harness";

const region = process.env.AWS_REGION ?? "us-west-2";

async function main(): Promise<void> {
  const policyService = new PolicyService({ region, credentials: fromIni() });
  const log = (msg: string) => console.log(msg);

  console.log("Listing policies…");
  const policies = await policyService.listPolicies();
  const orphaned = policies.filter(p => p.name.startsWith("benchmark-"));

  if (orphaned.length === 0) {
    console.log("No orphaned benchmark policies found.");
    return;
  }

  console.log(`Found ${orphaned.length} orphaned benchmark policies:`);
  for (const p of orphaned) {
    console.log(`  ${p.name} (${p.policyArn})`);
  }

  for (const p of orphaned) {
    try {
      await deletePolicy(policyService, p.policyArn, log);
      console.log(`  Deleted: ${p.name}`);
    } catch (err) {
      console.error(`  Failed to delete ${p.name}: ${(err as Error).message}`);
    }
  }

  console.log("Cleanup complete.");
}

main().catch(console.error);
