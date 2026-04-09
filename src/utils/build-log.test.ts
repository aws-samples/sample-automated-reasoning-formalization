/**
 * Unit tests for build log parsing and error extraction.
 */
import { describe, it, expect } from "vitest";
import { parseBuildLogAsset, extractBuildErrors } from "./build-log";
import type { BuildLogEntry } from "../types";

// ── Helper ──

function makeEntry(overrides: Partial<BuildLogEntry> = {}): BuildLogEntry {
  return {
    status: "APPLIED",
    annotation: { addRule: { ruleId: "r1" } },
    buildSteps: [],
    ...overrides,
  };
}

// ── parseBuildLogAsset ──

describe("parseBuildLogAsset", () => {
  it("returns empty array for null/undefined", () => {
    expect(parseBuildLogAsset(null)).toEqual([]);
    expect(parseBuildLogAsset(undefined)).toEqual([]);
  });

  it("returns empty array for non-object input", () => {
    expect(parseBuildLogAsset("string")).toEqual([]);
    expect(parseBuildLogAsset(42)).toEqual([]);
  });

  it("parses { buildLog: { entries: [...] } } wrapper", () => {
    const asset = {
      buildLog: {
        entries: [makeEntry()],
      },
    };
    const result = parseBuildLogAsset(asset);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("APPLIED");
  });

  it("parses { entries: [...] } wrapper", () => {
    const asset = { entries: [makeEntry()] };
    const result = parseBuildLogAsset(asset);
    expect(result).toHaveLength(1);
  });

  it("returns empty array when no entries key exists", () => {
    expect(parseBuildLogAsset({ something: "else" })).toEqual([]);
  });

  it("filters out entries missing status or buildSteps", () => {
    const asset = {
      entries: [
        makeEntry(),
        { annotation: {} }, // missing status and buildSteps
        { status: "APPLIED" }, // missing buildSteps
      ],
    };
    const result = parseBuildLogAsset(asset);
    expect(result).toHaveLength(1);
  });

  it("returns empty array for empty entries", () => {
    expect(parseBuildLogAsset({ entries: [] })).toEqual([]);
  });
});

// ── extractBuildErrors ──

describe("extractBuildErrors", () => {
  it("returns empty array for no entries", () => {
    expect(extractBuildErrors([])).toEqual([]);
  });

  it("extracts errors from FAILED entries", () => {
    const entries: BuildLogEntry[] = [
      makeEntry({
        status: "FAILED",
        annotation: { addRule: { ruleId: "r1" } },
        buildSteps: [
          {
            context: {},
            messages: [{ message: "Rule conflict", messageType: "ERROR" }],
          },
        ],
      }),
    ];
    const errors = extractBuildErrors(entries);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("ERROR");
    expect(errors[0]).toContain("Rule conflict");
  });

  it("reports FAILED entries with no details", () => {
    const entries: BuildLogEntry[] = [
      makeEntry({
        status: "FAILED",
        annotation: { addRule: {} },
        buildSteps: [],
      }),
    ];
    const errors = extractBuildErrors(entries);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("FAILED (no details provided)");
  });

  it("extracts ERROR messages from APPLIED entries", () => {
    const entries: BuildLogEntry[] = [
      makeEntry({
        status: "APPLIED",
        annotation: { addVariable: { name: "x" } },
        buildSteps: [
          {
            context: {},
            messages: [
              { message: "All good", messageType: "INFO" },
              { message: "Something wrong", messageType: "ERROR" },
            ],
          },
        ],
      }),
    ];
    const errors = extractBuildErrors(entries);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Something wrong");
  });

  it("includes both ERROR and WARNING from FAILED entries", () => {
    const entries: BuildLogEntry[] = [
      makeEntry({
        status: "FAILED",
        buildSteps: [
          {
            context: {},
            messages: [
              { message: "warn msg", messageType: "WARNING" },
              { message: "err msg", messageType: "ERROR" },
            ],
          },
        ],
      }),
    ];
    const errors = extractBuildErrors(entries);
    expect(errors).toHaveLength(2);
  });

  it("handles mixed APPLIED and FAILED entries", () => {
    const entries: BuildLogEntry[] = [
      makeEntry({ status: "APPLIED", buildSteps: [] }),
      makeEntry({
        status: "FAILED",
        buildSteps: [
          { context: {}, messages: [{ message: "fail", messageType: "ERROR" }] },
        ],
      }),
    ];
    const errors = extractBuildErrors(entries);
    expect(errors).toHaveLength(1);
  });
});
