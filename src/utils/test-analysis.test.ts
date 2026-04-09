/**
 * Unit tests for test analysis prompt building and highlight computation.
 */
import { describe, it, expect } from "vitest";
import { buildTestAnalysisPrompt, computeTestHighlightFilter } from "./test-analysis";
import type { TestCaseWithResult } from "../types";

// ── Helper ──

function makeTest(overrides: Partial<TestCaseWithResult> = {}): TestCaseWithResult {
  return {
    testCase: {
      testCaseId: "tc-1",
      guardContent: "The user is a manager",
      queryContent: "Can they approve?",
      expectedAggregatedFindingsResult: "VALID",
    } as TestCaseWithResult["testCase"],
    ...overrides,
  };
}

// ── buildTestAnalysisPrompt ──

describe("buildTestAnalysisPrompt", () => {
  it("includes guard content and query content", () => {
    const prompt = buildTestAnalysisPrompt(makeTest());
    expect(prompt).toContain("The user is a manager");
    expect(prompt).toContain("Can they approve?");
  });

  it("indicates test has not been run when no actual result", () => {
    const prompt = buildTestAnalysisPrompt(makeTest());
    expect(prompt).toContain("Not yet run");
    expect(prompt).toContain("has not been run yet");
  });

  it("indicates passing test when actual matches expected", () => {
    const test = makeTest({ aggregatedTestFindingsResult: "VALID" });
    const prompt = buildTestAnalysisPrompt(test);
    expect(prompt).toContain("passing");
  });

  it("indicates failing test with diagnosis guidance", () => {
    const test = makeTest({ aggregatedTestFindingsResult: "INVALID" });
    const prompt = buildTestAnalysisPrompt(test);
    expect(prompt).toContain("FAILING");
    expect(prompt).toContain("root cause");
    expect(prompt).toContain("follow-up-prompt");
  });

  it("handles missing guardContent gracefully", () => {
    const test = makeTest({
      testCase: {
        testCaseId: "tc-2",
        expectedAggregatedFindingsResult: "VALID",
      } as TestCaseWithResult["testCase"],
    });
    // Should not throw
    const prompt = buildTestAnalysisPrompt(test);
    expect(prompt).toContain("[TEST ANALYSIS]");
  });

  it("includes findings JSON when present", () => {
    const test = makeTest({
      aggregatedTestFindingsResult: "INVALID",
      testFindings: [{ valid: { supportingRules: [{ id: "r1" }] } }] as TestCaseWithResult["testFindings"],
    });
    const prompt = buildTestAnalysisPrompt(test);
    expect(prompt).toContain("r1");
  });

  it("includes implication-direction hint for SATISFIABLE when expecting VALID", () => {
    const test = makeTest({
      aggregatedTestFindingsResult: "SATISFIABLE",
    });
    const prompt = buildTestAnalysisPrompt(test);
    expect(prompt).toContain("wrong implication direction");
    expect(prompt).toContain("does NOT mean");
  });

  it("does not include implication hint for non-SATISFIABLE failures", () => {
    const test = makeTest({
      aggregatedTestFindingsResult: "INVALID",
    });
    const prompt = buildTestAnalysisPrompt(test);
    expect(prompt).not.toContain("wrong implication direction");
  });

  it("lists rule fixes before description tweaks in remediation strategies", () => {
    const test = makeTest({
      aggregatedTestFindingsResult: "INVALID",
    });
    const prompt = buildTestAnalysisPrompt(test);
    const rulesIdx = prompt.indexOf("Add or update rules");
    const descriptionsIdx = prompt.indexOf("Improve variable descriptions");
    expect(rulesIdx).toBeGreaterThan(-1);
    expect(descriptionsIdx).toBeGreaterThan(-1);
    expect(rulesIdx).toBeLessThan(descriptionsIdx);
  });
});

// ── computeTestHighlightFilter ──

describe("computeTestHighlightFilter", () => {
  it("returns empty filter when no findings", () => {
    const result = computeTestHighlightFilter(makeTest(), null);
    expect(result.hasFilter).toBe(false);
    expect(result.directRuleIds).toEqual([]);
    expect(result.variables).toEqual([]);
  });

  it("returns empty filter for empty findings array", () => {
    const test = makeTest({ testFindings: [] });
    const result = computeTestHighlightFilter(test, null);
    expect(result.hasFilter).toBe(false);
  });

  it("extracts direct rule IDs from valid findings", () => {
    const test = makeTest({
      testFindings: [
        { valid: { supportingRules: [{ id: "r1" }, { id: "r2" }] } },
      ] as TestCaseWithResult["testFindings"],
    });
    const result = computeTestHighlightFilter(test, null);
    expect(result.directRuleIds).toContain("r1");
    expect(result.directRuleIds).toContain("r2");
    expect(result.hasFilter).toBe(true);
  });

  it("infers rule IDs from variables when definition provided", () => {
    const test = makeTest({
      testFindings: [
        {
          valid: {
            translation: {
              premises: [{ logic: "(= userAge 25)" }],
              claims: [],
            },
          },
        },
      ] as unknown as TestCaseWithResult["testFindings"],
    });
    const definition = {
      rules: [
        { ruleId: "r1", expression: "(=> (> userAge 18) allowed)" },
        { ruleId: "r2", expression: "(=> (= role ADMIN) allowed)" },
      ],
      variables: [
        { name: "userAge", type: "INT", description: "Age" },
        { name: "role", type: "string", description: "Role" },
      ],
    } as unknown as import("@aws-sdk/client-bedrock").AutomatedReasoningPolicyDefinition;

    const result = computeTestHighlightFilter(test, definition);
    expect(result.variables).toContain("userAge");
    expect(result.variables).not.toContain("role");
    expect(result.inferredRuleIds).toContain("r1");
    expect(result.hasFilter).toBe(true);
  });

  it("returns no inferred rules when definition is null", () => {
    const test = makeTest({
      testFindings: [
        { valid: { supportingRules: [{ id: "r1" }] } },
      ] as TestCaseWithResult["testFindings"],
    });
    const result = computeTestHighlightFilter(test, null);
    expect(result.inferredRuleIds).toEqual([]);
    expect(result.variables).toEqual([]);
  });
});
