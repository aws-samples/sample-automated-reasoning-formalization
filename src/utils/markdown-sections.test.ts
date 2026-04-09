/**
 * Unit tests for markdown section parsing.
 */
import { describe, it, expect } from "vitest";
import { parseMarkdownSections, subdivideLargeSections } from "./markdown-sections";

describe("parseMarkdownSections", () => {
  it("returns empty array for empty document", () => {
    expect(parseMarkdownSections("")).toEqual([]);
  });

  it("returns empty array for whitespace-only document", () => {
    expect(parseMarkdownSections("   \n  \n  ")).toEqual([]);
  });

  it("returns preamble when no headings exist", () => {
    const result = parseMarkdownSections("Just some text\nwith no headings.");
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("(Preamble)");
    expect(result[0].level).toBe(0);
    expect(result[0].content).toContain("Just some text");
  });

  it("skips single H1 as document title", () => {
    const doc = "# My Document\n\nIntro text\n\n## Section One\n\nContent one\n\n## Section Two\n\nContent two";
    const result = parseMarkdownSections(doc);
    // H1 is treated as title, not a section boundary — sections start from ##
    const titles = result.map((s) => s.title);
    expect(titles).not.toContain("My Document");
    expect(titles).toContain("Section One");
    expect(titles).toContain("Section Two");
  });

  it("treats multiple H1s as section boundaries", () => {
    const doc = "# Part One\n\nContent\n\n# Part Two\n\nContent";
    const result = parseMarkdownSections(doc);
    const titles = result.map((s) => s.title);
    expect(titles).toContain("Part One");
    expect(titles).toContain("Part Two");
  });

  it("handles mixed heading levels up to maxLevel", () => {
    const doc = "## Section\n\nText\n\n### Subsection\n\nMore text";
    const result = parseMarkdownSections(doc, 3);
    expect(result).toHaveLength(2);
    expect(result[0].level).toBe(2);
    expect(result[1].level).toBe(3);
  });

  it("respects maxLevel=2 by ignoring ### headings", () => {
    const doc = "## Section\n\nText\n\n### Subsection\n\nMore text";
    const result = parseMarkdownSections(doc, 2);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Section");
    expect(result[0].content).toContain("### Subsection");
  });

  it("generates stable slugified IDs", () => {
    const doc = "## Eligibility Criteria\n\nContent";
    const result = parseMarkdownSections(doc);
    expect(result[0].id).toBe("s0-eligibility-criteria");
  });

  it("includes preamble before first heading", () => {
    const doc = "Some intro text\n\n## First Section\n\nContent";
    const result = parseMarkdownSections(doc);
    expect(result[0].title).toBe("(Preamble)");
    expect(result[0].content).toContain("Some intro text");
    expect(result[1].title).toBe("First Section");
  });

  it("handles consecutive headings with no body", () => {
    const doc = "## A\n## B\n## C";
    const result = parseMarkdownSections(doc);
    expect(result).toHaveLength(3);
    expect(result.map((s) => s.title)).toEqual(["A", "B", "C"]);
  });

  it("handles headings with special characters", () => {
    const doc = '## Section (with parens) & "quotes"\n\nContent';
    const result = parseMarkdownSections(doc);
    expect(result[0].title).toBe('Section (with parens) & "quotes"');
    // ID should be slugified
    expect(result[0].id).toMatch(/^s0-/);
  });

  it("tracks correct startLine and endLine", () => {
    const doc = "## First\n\nLine 1\nLine 2\n\n## Second\n\nLine 3";
    const result = parseMarkdownSections(doc);
    expect(result[0].startLine).toBe(0);
    expect(result[1].startLine).toBe(5);
    expect(result[1].endLine).toBe(8);
  });
});

describe("subdivideLargeSections", () => {
  it("returns small sections unchanged", () => {
    const sections = parseMarkdownSections("## Small\n\nShort content.");
    const result = subdivideLargeSections(sections, 4000);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(sections[0].id);
  });

  it("subdivides a section exceeding maxSize at paragraph boundaries", () => {
    // Create a section with multiple paragraphs totaling > 100 chars
    const para1 = "A".repeat(60);
    const para2 = "B".repeat(60);
    const para3 = "C".repeat(60);
    const doc = `## Big Section\n\n${para1}\n\n${para2}\n\n${para3}`;
    const sections = parseMarkdownSections(doc);
    expect(sections).toHaveLength(1);

    const result = subdivideLargeSections(sections, 100);
    expect(result.length).toBeGreaterThan(1);

    // First sub-section keeps the original title
    expect(result[0].title).toBe("Big Section");
    // Subsequent sub-sections get "(cont.)" suffix
    expect(result[1].title).toBe("Big Section (cont.)");

    // IDs include part index
    expect(result[0].id).toMatch(/-p0$/);
    expect(result[1].id).toMatch(/-p1$/);
  });

  it("preserves content across subdivisions", () => {
    const para1 = "First paragraph content.";
    const para2 = "Second paragraph content.";
    const doc = `## Section\n\n${para1}\n\n${para2}`;
    const sections = parseMarkdownSections(doc);

    // Use a maxSize that forces a split between the two paragraphs
    const result = subdivideLargeSections(sections, 40);

    const allContent = result.map((s) => s.content).join("\n\n");
    expect(allContent).toContain(para1);
    expect(allContent).toContain(para2);
  });

  it("handles sections with no paragraph breaks", () => {
    const longLine = "X".repeat(200);
    const doc = `## No Breaks\n\n${longLine}`;
    const sections = parseMarkdownSections(doc);

    // Can't split at paragraph boundaries, so returns as single section
    const result = subdivideLargeSections(sections, 100);
    // The heading + content is one chunk since there are no paragraph breaks to split on
    expect(result.length).toBeGreaterThanOrEqual(1);
    const allContent = result.map((s) => s.content).join("");
    expect(allContent).toContain(longLine);
  });

  it("does not modify sections under the threshold", () => {
    const sections = [
      { id: "s0-small", title: "Small", level: 2, startLine: 0, endLine: 5, content: "Short" },
      { id: "s1-also-small", title: "Also Small", level: 2, startLine: 5, endLine: 10, content: "Also short" },
    ];
    const result = subdivideLargeSections(sections, 4000);
    expect(result).toEqual(sections);
  });
});
