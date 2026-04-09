/**
 * Parsing and filtering utilities for POLICY_SCENARIOS assets.
 *
 * After a policy build completes, the API returns a set of satisfiable
 * scenarios. This module selects a diverse, high-coverage subset of 10
 * scenarios optimized for:
 *   1. Exercising as many distinct rules as possible
 *   2. Preferring compound scenarios (AND / OR — multiple variables)
 *   3. Maximizing variable diversity (avoiding near-duplicate scenarios)
 */
import type { PolicyScenario } from "../types";

const TARGET_COUNT = 10;

// ── Parsing ──

/**
 * Parse a raw POLICY_SCENARIOS asset from the SDK into a typed array.
 * Returns an empty array if the asset is falsy or malformed.
 */
export function parseScenariosAsset(asset: unknown): PolicyScenario[] {
  if (!asset) return [];
  const raw = asset as Record<string, unknown>;
  const wrapper = (raw.policyScenarios ?? raw) as Record<string, unknown>;
  const arr = wrapper.policyScenarios ?? wrapper;
  if (!Array.isArray(arr)) return [];
  return arr.filter(
    (s: unknown): s is PolicyScenario =>
      !!s &&
      typeof (s as PolicyScenario).expression === "string" &&
      typeof (s as PolicyScenario).alternateExpression === "string" &&
      Array.isArray((s as PolicyScenario).ruleIds),
  );
}

// ── Variable extraction ──

/** Extract variable names referenced in an SMT-LIB expression via `(= varName ...)` patterns. */
function extractVariables(expression: string): Set<string> {
  const vars = new Set<string>();
  const re = /\(=\s+(\w+)\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expression)) !== null) {
    vars.add(m[1]);
  }
  return vars;
}

/** Check whether an expression contains AND or OR connectives (compound scenario). */
function isCompound(expression: string): boolean {
  return /\(\s*(and|or)\b/i.test(expression);
}

// ── Scoring & selection ──

interface ScoredScenario {
  scenario: PolicyScenario;
  /** Number of rules exercised */
  ruleCount: number;
  /** Whether the expression is compound (AND/OR) */
  compound: boolean;
  /** Set of variable names in the expression */
  variables: Set<string>;
}

/**
 * Select up to 10 diverse, high-coverage scenarios from the full set.
 *
 * Algorithm:
 *  1. Score each scenario by rule count and compound-ness.
 *  2. Sort descending by (compound, ruleCount).
 *  3. Greedily pick scenarios that maximize cumulative rule and variable coverage,
 *     penalizing candidates whose variables heavily overlap with already-selected ones.
 */
export function selectScenarios(all: PolicyScenario[]): PolicyScenario[] {
  if (all.length <= TARGET_COUNT) return [...all];

  const scored: ScoredScenario[] = all.map((s) => ({
    scenario: s,
    ruleCount: s.ruleIds.length,
    compound: isCompound(s.expression),
    variables: extractVariables(s.expression),
  }));

  // Sort: compound first, then by rule count descending
  scored.sort((a, b) => {
    if (a.compound !== b.compound) return a.compound ? -1 : 1;
    return b.ruleCount - a.ruleCount;
  });

  const selected: ScoredScenario[] = [];
  const coveredRules = new Set<string>();
  const coveredVars = new Set<string>();

  for (const candidate of scored) {
    if (selected.length >= TARGET_COUNT) break;

    // Calculate how many new rules and variables this candidate adds
    const newRules = candidate.scenario.ruleIds.filter((r) => !coveredRules.has(r)).length;
    const newVars = [...candidate.variables].filter((v) => !coveredVars.has(v)).length;

    // Skip if this candidate adds nothing new and we already have some picks
    if (selected.length > 0 && newRules === 0 && newVars === 0) continue;

    // Penalize high overlap: if >80% of variables are already covered, skip
    // (unless we haven't filled the set yet and it still adds rules)
    if (
      selected.length > 0 &&
      candidate.variables.size > 0 &&
      newVars === 0 &&
      newRules <= 1
    ) {
      continue;
    }

    selected.push(candidate);
    for (const r of candidate.scenario.ruleIds) coveredRules.add(r);
    for (const v of candidate.variables) coveredVars.add(v);
  }

  // If we still have room, backfill from remaining candidates
  if (selected.length < TARGET_COUNT) {
    const selectedSet = new Set(selected);
    for (const candidate of scored) {
      if (selected.length >= TARGET_COUNT) break;
      if (selectedSet.has(candidate)) continue;
      selected.push(candidate);
    }
  }

  return selected.map((s) => s.scenario);
}
