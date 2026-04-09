/**
 * Unit tests for fidelity report parsing utility.
 */
import { describe, it, expect } from "vitest";
import { parseFidelityAsset } from "./fidelity";

describe("parseFidelityAsset", () => {
  it("returns null for null input", () => {
    expect(parseFidelityAsset(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(parseFidelityAsset(undefined)).toBeNull();
  });

  it("returns null for empty object (no coverageScore)", () => {
    expect(parseFidelityAsset({})).toBeNull();
  });

  it("parses a top-level fidelity report", () => {
    const asset = {
      coverageScore: 0.85,
      accuracyScore: 0.92,
      ruleReports: {},
      variableReports: {},
      documentSources: [],
    };
    const result = parseFidelityAsset(asset);
    expect(result).not.toBeNull();
    expect(result!.coverageScore).toBe(0.85);
    expect(result!.accuracyScore).toBe(0.92);
  });

  it("parses a nested fidelityReport wrapper", () => {
    const asset = {
      fidelityReport: {
        coverageScore: 0.75,
        accuracyScore: 0.88,
        ruleReports: { r1: { rule: "r1" } },
        variableReports: {},
        documentSources: [],
      },
    };
    const result = parseFidelityAsset(asset);
    expect(result).not.toBeNull();
    expect(result!.coverageScore).toBe(0.75);
  });

  it("returns null when nested fidelityReport has no coverageScore", () => {
    const asset = { fidelityReport: { accuracyScore: 0.5 } };
    expect(parseFidelityAsset(asset)).toBeNull();
  });

  it("preserves extra fields in the report", () => {
    const asset = {
      coverageScore: 1.0,
      accuracyScore: 1.0,
      ruleReports: {},
      variableReports: {},
      documentSources: [],
      extraField: "should be preserved",
    };
    const result = parseFidelityAsset(asset) as Record<string, unknown>;
    expect(result).not.toBeNull();
    expect(result.extraField).toBe("should be preserved");
  });

  it("handles coverageScore of 0 (falsy but valid)", () => {
    const asset = { coverageScore: 0, accuracyScore: 0 };
    const result = parseFidelityAsset(asset);
    expect(result).not.toBeNull();
    expect(result!.coverageScore).toBe(0);
  });
});
