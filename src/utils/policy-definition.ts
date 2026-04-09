/**
 * SDK → app type conversion for policy definitions.
 *
 * The AWS SDK's AutomatedReasoningPolicyDefinition and the app's
 * PolicyDefinition are structurally similar but not directly assignable.
 * This module provides the single boundary conversion so every consumer
 * can work with the app type without unsafe double-casts.
 */
import type { AutomatedReasoningPolicyDefinition } from "@aws-sdk/client-bedrock";
import type { PolicyDefinition, PolicyType, PolicyRule, PolicyVariable } from "../types";

/**
 * Convert the raw AWS SDK definition into the app's PolicyDefinition shape.
 *
 * Call this once when data enters the app (e.g. after an API export)
 * rather than casting at every use site.
 */
export function toAppDefinition(raw: AutomatedReasoningPolicyDefinition): PolicyDefinition {
  return {
    version: raw.version ?? "1.0",
    types: (raw.types ?? []) as unknown as PolicyType[],
    rules: (raw.rules ?? []) as unknown as PolicyRule[],
    variables: (raw.variables ?? []) as unknown as PolicyVariable[],
  };
}
