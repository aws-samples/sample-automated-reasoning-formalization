/**
 * Utilities for extracting relevant rule IDs and variable names
 * from AutomatedReasoningCheckFinding results.
 */
import type { AutomatedReasoningCheckFinding, PolicyDefinition } from "../types";

/**
 * Extract rule IDs referenced in test findings.
 * Collects supportingRules from VALID findings and contradictingRules
 * from INVALID/IMPOSSIBLE findings.
 */
export function extractRelevantRuleIds(findings: AutomatedReasoningCheckFinding[]): string[] {
  const ids = new Set<string>();
  for (const f of findings) {
    if (f.valid) {
      for (const r of f.valid.supportingRules ?? []) {
        if (r.id) ids.add(r.id);
      }
    }
    if (f.invalid) {
      for (const r of f.invalid.contradictingRules ?? []) {
        if (r.id) ids.add(r.id);
      }
    }
    if (f.impossible) {
      for (const r of f.impossible.contradictingRules ?? []) {
        if (r.id) ids.add(r.id);
      }
    }
  }
  return [...ids];
}

/**
 * Extract variable names referenced in test findings' translations.
 * Parses the logic expressions in premises and claims, matching against
 * known variable names from the policy definition.
 */
export function extractRelevantVariables(
  findings: AutomatedReasoningCheckFinding[],
  definition: PolicyDefinition
): string[] {
  const knownVars = new Set(definition.variables.map((v) => v.name));
  const found = new Set<string>();

  for (const f of findings) {
    const translation =
      f.valid?.translation ?? f.invalid?.translation ??
      f.satisfiable?.translation ?? f.impossible?.translation;
    if (!translation) continue;

    const statements = [...(translation.premises ?? []), ...(translation.claims ?? [])];
    for (const stmt of statements) {
      if (!stmt.logic) continue;
      // Match variable names that appear in the SMT-LIB logic expression
      for (const varName of knownVars) {
        if (stmt.logic.includes(varName)) {
          found.add(varName);
        }
      }
    }
  }
  return [...found];
}
