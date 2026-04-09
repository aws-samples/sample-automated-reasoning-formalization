/**
 * Unit tests for test findings extraction utilities.
 */
import { describe, it, expect } from "vitest";
import { extractRelevantRuleIds, extractRelevantVariables } from "./test-findings";
import type { AutomatedReasoningCheckFinding, PolicyDefinition } from "../types";

// ── extractRelevantRuleIds ──

describe("extractRelevantRuleIds", () => {
  it("returns empty array for empty findings", () => {
    expect(extractRelevantRuleIds([])).toEqual([]);
  });

  it("extracts supportingRules from valid findings", () => {
    const findings = [
      { valid: { supportingRules: [{ id: "r1" }, { id: "r2" }] } },
    ] as unknown as AutomatedReasoningCheckFinding[];
    expect(extractRelevantRuleIds(findings)).toEqual(["r1", "r2"]);
  });

  it("extracts contradictingRules from invalid findings", () => {
    const findings = [
      { invalid: { contradictingRules: [{ id: "r3" }] } },
    ] as unknown as AutomatedReasoningCheckFinding[];
    expect(extractRelevantRuleIds(findings)).toEqual(["r3"]);
  });

  it("extracts contradictingRules from impossible findings", () => {
    const findings = [
      { impossible: { contradictingRules: [{ id: "r4" }, { id: "r5" }] } },
    ] as unknown as AutomatedReasoningCheckFinding[];
    const result = extractRelevantRuleIds(findings);
    expect(result).toContain("r4");
    expect(result).toContain("r5");
  });

  it("deduplicates rule IDs across findings", () => {
    const findings = [
      { valid: { supportingRules: [{ id: "r1" }] } },
      { invalid: { contradictingRules: [{ id: "r1" }] } },
    ] as unknown as AutomatedReasoningCheckFinding[];
    expect(extractRelevantRuleIds(findings)).toEqual(["r1"]);
  });

  it("handles findings with no rules", () => {
    const findings = [
      { valid: { supportingRules: [] } },
      { invalid: {} },
    ] as unknown as AutomatedReasoningCheckFinding[];
    expect(extractRelevantRuleIds(findings)).toEqual([]);
  });

  it("handles mixed finding types", () => {
    const findings = [
      { valid: { supportingRules: [{ id: "r1" }] } },
      { invalid: { contradictingRules: [{ id: "r2" }] } },
      { impossible: { contradictingRules: [{ id: "r3" }] } },
    ] as unknown as AutomatedReasoningCheckFinding[];
    const result = extractRelevantRuleIds(findings);
    expect(result).toHaveLength(3);
    expect(result).toContain("r1");
    expect(result).toContain("r2");
    expect(result).toContain("r3");
  });

  it("skips rules with no id", () => {
    const findings = [
      { valid: { supportingRules: [{ id: "r1" }, {}] } },
    ] as unknown as AutomatedReasoningCheckFinding[];
    expect(extractRelevantRuleIds(findings)).toEqual(["r1"]);
  });
});

// ── extractRelevantVariables ──

describe("extractRelevantVariables", () => {
  const definition: PolicyDefinition = {
    version: "1.0",
    types: [],
    rules: [],
    variables: [
      { name: "userAge", type: "INT", description: "Age" },
      { name: "isManager", type: "BOOL", description: "Manager flag" },
      { name: "salary", type: "REAL", description: "Salary" },
    ],
  };

  it("returns empty array for empty findings", () => {
    expect(extractRelevantVariables([], definition)).toEqual([]);
  });

  it("extracts variables from premises", () => {
    const findings = [
      {
        valid: {
          translation: {
            premises: [{ logic: "(= userAge 25)" }],
            claims: [],
          },
        },
      },
    ] as unknown as AutomatedReasoningCheckFinding[];
    const result = extractRelevantVariables(findings, definition);
    expect(result).toContain("userAge");
  });

  it("extracts variables from claims", () => {
    const findings = [
      {
        valid: {
          translation: {
            premises: [],
            claims: [{ logic: "(= isManager true)" }],
          },
        },
      },
    ] as unknown as AutomatedReasoningCheckFinding[];
    const result = extractRelevantVariables(findings, definition);
    expect(result).toContain("isManager");
  });

  it("filters out unknown variables not in definition", () => {
    const findings = [
      {
        valid: {
          translation: {
            premises: [{ logic: "(= unknownVar 42)" }],
            claims: [],
          },
        },
      },
    ] as unknown as AutomatedReasoningCheckFinding[];
    expect(extractRelevantVariables(findings, definition)).toEqual([]);
  });

  it("deduplicates variables", () => {
    const findings = [
      {
        valid: {
          translation: {
            premises: [{ logic: "(= userAge 25)" }],
            claims: [{ logic: "(> userAge 18)" }],
          },
        },
      },
    ] as unknown as AutomatedReasoningCheckFinding[];
    const result = extractRelevantVariables(findings, definition);
    expect(result).toEqual(["userAge"]);
  });

  it("handles findings with no translation", () => {
    const findings = [
      { valid: {} },
      { invalid: {} },
    ] as unknown as AutomatedReasoningCheckFinding[];
    expect(extractRelevantVariables(findings, definition)).toEqual([]);
  });

  it("handles statements with no logic field", () => {
    const findings = [
      {
        valid: {
          translation: {
            premises: [{ text: "no logic here" }],
            claims: [],
          },
        },
      },
    ] as unknown as AutomatedReasoningCheckFinding[];
    expect(extractRelevantVariables(findings, definition)).toEqual([]);
  });

  it("extracts from satisfiable findings", () => {
    const findings = [
      {
        satisfiable: {
          translation: {
            premises: [{ logic: "(= salary 50000)" }],
            claims: [],
          },
        },
      },
    ] as unknown as AutomatedReasoningCheckFinding[];
    const result = extractRelevantVariables(findings, definition);
    expect(result).toContain("salary");
  });
});
