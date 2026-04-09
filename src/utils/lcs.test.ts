/**
 * Unit tests for word-level LCS algorithm.
 */
import { describe, it, expect } from "vitest";
import { wordLCS } from "./lcs";

describe("wordLCS", () => {
  it("returns empty LCS for empty arrays", () => {
    expect(wordLCS([], [])).toEqual({ lcs: [], ratio: 0 });
    expect(wordLCS(["a"], [])).toEqual({ lcs: [], ratio: 0 });
    expect(wordLCS([], ["b"])).toEqual({ lcs: [], ratio: 0 });
  });

  it("finds exact match", () => {
    const result = wordLCS(["the", "cat", "sat"], ["the", "cat", "sat"]);
    expect(result.lcs).toEqual(["the", "cat", "sat"]);
    expect(result.ratio).toBe(1);
  });

  it("finds subsequence in longer array", () => {
    const a = ["cat", "sat"];
    const b = ["the", "cat", "quickly", "sat", "down"];
    const result = wordLCS(a, b);
    expect(result.lcs).toEqual(["cat", "sat"]);
    expect(result.ratio).toBe(1);
  });

  it("handles no common words", () => {
    const result = wordLCS(["apple", "banana"], ["cherry", "date"]);
    expect(result.lcs).toEqual([]);
    expect(result.ratio).toBe(0);
  });

  it("computes correct ratio for partial match", () => {
    const a = ["a", "b", "c", "d"];
    const b = ["a", "x", "c", "y"];
    const result = wordLCS(a, b);
    expect(result.lcs).toEqual(["a", "c"]);
    expect(result.ratio).toBe(0.5);
  });

  it("handles single-element arrays", () => {
    expect(wordLCS(["x"], ["x"]).lcs).toEqual(["x"]);
    expect(wordLCS(["x"], ["y"]).lcs).toEqual([]);
  });

  it("preserves order of subsequence", () => {
    const a = ["a", "b", "c"];
    const b = ["c", "b", "a"];
    const result = wordLCS(a, b);
    // LCS of [a,b,c] and [c,b,a] is length 1 (any single element)
    expect(result.lcs).toHaveLength(1);
  });
});
