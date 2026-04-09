/**
 * Tests for card helper utilities.
 */
import { describe, it, expect } from "vitest";
import { generateApprovalCode } from "./card-helpers";

describe("generateApprovalCode", () => {
  it("generates a string with 5 segments separated by dashes", () => {
    const code = generateApprovalCode();
    const segments = code.split("-");
    expect(segments).toHaveLength(5);
  });

  it("generates segments of correct lengths (8-4-4-4-12)", () => {
    const code = generateApprovalCode();
    const segments = code.split("-");
    expect(segments[0]).toHaveLength(8);
    expect(segments[1]).toHaveLength(4);
    expect(segments[2]).toHaveLength(4);
    expect(segments[3]).toHaveLength(4);
    expect(segments[4]).toHaveLength(12);
  });

  it("generates unique codes on successive calls", () => {
    const codes = new Set(Array.from({ length: 10 }, () => generateApprovalCode()));
    expect(codes.size).toBe(10);
  });

  it("uses only alphanumeric characters", () => {
    const code = generateApprovalCode();
    const withoutDashes = code.replace(/-/g, "");
    expect(withoutDashes).toMatch(/^[A-Za-z0-9]+$/);
  });
});
