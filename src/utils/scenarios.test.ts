/**
 * Unit tests for scenario parsing and selection utilities.
 */
import { describe, it, expect } from "vitest";
import { parseScenariosAsset, selectScenarios } from "./scenarios";
import type { PolicyScenario } from "../types";

// ── Helper ──

function makeScenario(overrides: Partial<PolicyScenario> = {}): PolicyScenario {
  return {
    expression: "(=> (= x true) (= y true))",
    alternateExpression: "If x then y",
    ruleIds: ["r1"],
    expectedResult: "VALID",
    ...overrides,
  };
}

// ── parseScenariosAsset ──

describe("parseScenariosAsset", () => {
  it("returns empty array for null/undefined", () => {
    expect(parseScenariosAsset(null)).toEqual([]);
    expect(parseScenariosAsset(undefined)).toEqual([]);
  });

  it("returns empty array for empty object", () => {
    expect(parseScenariosAsset({})).toEqual([]);
  });

  it("returns empty array for non-array payload", () => {
    expect(parseScenariosAsset({ policyScenarios: "not an array" })).toEqual([]);
  });

  it("parses top-level array", () => {
    const scenarios = [makeScenario()];
    // Wrapped in the double-nested shape the SDK returns
    const asset = { policyScenarios: { policyScenarios: scenarios } };
    const result = parseScenariosAsset(asset);
    expect(result).toHaveLength(1);
    expect(result[0].expression).toBe("(=> (= x true) (= y true))");
  });

  it("parses flat array wrapper", () => {
    const scenarios = [makeScenario()];
    const asset = { policyScenarios: scenarios };
    const result = parseScenariosAsset(asset);
    expect(result).toHaveLength(1);
  });

  it("filters out malformed entries (missing expression)", () => {
    const asset = [
      makeScenario(),
      { alternateExpression: "no expression", ruleIds: [] },
    ];
    const result = parseScenariosAsset(asset);
    expect(result).toHaveLength(1);
  });

  it("filters out entries missing ruleIds", () => {
    const asset = [
      makeScenario(),
      { expression: "x", alternateExpression: "y" },
    ];
    const result = parseScenariosAsset(asset);
    expect(result).toHaveLength(1);
  });

  it("filters out entries missing alternateExpression", () => {
    const asset = [
      makeScenario(),
      { expression: "x", ruleIds: ["r1"] },
    ];
    const result = parseScenariosAsset(asset);
    expect(result).toHaveLength(1);
  });
});

// ── selectScenarios ──

describe("selectScenarios", () => {
  it("returns all scenarios when fewer than 10", () => {
    const scenarios = [makeScenario(), makeScenario({ ruleIds: ["r2"] })];
    const result = selectScenarios(scenarios);
    expect(result).toHaveLength(2);
  });

  it("returns all scenarios when exactly 10", () => {
    const scenarios = Array.from({ length: 10 }, (_, i) =>
      makeScenario({ ruleIds: [`r${i}`] }),
    );
    const result = selectScenarios(scenarios);
    expect(result).toHaveLength(10);
  });

  it("returns at most 10 scenarios when more than 10", () => {
    const scenarios = Array.from({ length: 20 }, (_, i) =>
      makeScenario({ ruleIds: [`r${i}`] }),
    );
    const result = selectScenarios(scenarios);
    expect(result).toHaveLength(10);
  });

  it("prefers compound scenarios (AND/OR) over simple ones", () => {
    const simple = Array.from({ length: 15 }, (_, i) =>
      makeScenario({
        expression: `(= x${i} true)`,
        ruleIds: [`r${i}`],
      }),
    );
    const compound = makeScenario({
      expression: "(and (= x true) (= y true))",
      ruleIds: ["rCompound"],
    });
    const all = [...simple, compound];
    const result = selectScenarios(all);
    // The compound scenario should be selected
    expect(result.some((s) => s.ruleIds.includes("rCompound"))).toBe(true);
  });

  it("maximizes rule coverage across selected scenarios", () => {
    // Create scenarios with unique rules and some with overlapping rules
    const unique = Array.from({ length: 8 }, (_, i) =>
      makeScenario({ ruleIds: [`unique-r${i}`], expression: `(= v${i} true)` }),
    );
    const overlapping = Array.from({ length: 8 }, () =>
      makeScenario({ ruleIds: ["shared-r"], expression: "(= shared true)" }),
    );
    const all = [...unique, ...overlapping];
    const result = selectScenarios(all);

    // All unique-rule scenarios should be preferred
    const selectedRules = new Set(result.flatMap((s) => s.ruleIds));
    for (let i = 0; i < 8; i++) {
      expect(selectedRules.has(`unique-r${i}`)).toBe(true);
    }
  });

  it("handles all scenarios with the same rules", () => {
    const scenarios = Array.from({ length: 15 }, () =>
      makeScenario({ ruleIds: ["r1"] }),
    );
    const result = selectScenarios(scenarios);
    expect(result).toHaveLength(10);
  });

  it("maximizes variable diversity", () => {
    // Scenarios with different variables should be preferred
    const scenarios = Array.from({ length: 15 }, (_, i) =>
      makeScenario({
        expression: `(= var${i} true)`,
        ruleIds: [`r${i}`],
      }),
    );
    const result = selectScenarios(scenarios);
    const allVars = new Set<string>();
    for (const s of result) {
      const matches = s.expression.matchAll(/\(=\s+(\w+)\s+/g);
      for (const m of matches) allVars.add(m[1]);
    }
    // Should have 10 distinct variables (one per selected scenario)
    expect(allVars.size).toBe(10);
  });

  it("returns empty array for empty input", () => {
    expect(selectScenarios([])).toEqual([]);
  });
});
