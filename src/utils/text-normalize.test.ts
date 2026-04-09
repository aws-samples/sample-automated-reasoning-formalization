/**
 * Unit tests for text normalization and tokenization.
 */
import { describe, it, expect } from "vitest";
import { normalizeForMatch, tokenize } from "./text-normalize";

describe("normalizeForMatch", () => {
  it("lowercases text", () => {
    expect(normalizeForMatch("Hello WORLD")).toBe("hello world");
  });

  it("collapses whitespace", () => {
    expect(normalizeForMatch("a   b\t\tc")).toBe("a b c");
  });

  it("strips punctuation except hyphens", () => {
    expect(normalizeForMatch("hello, world!")).toBe("hello world");
  });

  it("preserves hyphens within words", () => {
    expect(normalizeForMatch("under-16s allowed")).toBe("under-16s allowed");
  });

  it("normalizes smart quotes to ASCII equivalents", () => {
    // Smart single quotes → ASCII apostrophe (preserved by the regex)
    // Smart double quotes → ASCII double quote → stripped by punctuation removal
    const result = normalizeForMatch("\u2018single\u2019 \u201Cdouble\u201D");
    expect(result).toBe("single double");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeForMatch("  hello  ")).toBe("hello");
  });

  it("handles empty string", () => {
    expect(normalizeForMatch("")).toBe("");
  });
});

describe("tokenize", () => {
  it("splits into lowercase words", () => {
    expect(tokenize("Hello World")).toEqual(["hello", "world"]);
  });

  it("filters out empty tokens", () => {
    expect(tokenize("  a   b  ")).toEqual(["a", "b"]);
  });

  it("keeps hyphenated words intact", () => {
    expect(tokenize("under-16s not allowed")).toEqual(["under-16s", "not", "allowed"]);
  });

  it("returns empty array for empty string", () => {
    expect(tokenize("")).toEqual([]);
  });

  it("returns empty array for punctuation-only string", () => {
    expect(tokenize("!@#$%")).toEqual([]);
  });
});
