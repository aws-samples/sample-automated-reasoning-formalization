/**
 * Parse a markdown document into sections split on ATX headings (#, ##, ###).
 * Pure function — no side effects, no dependencies.
 */
import type { DocumentSection } from "../types";

/**
 * Slugify a heading title into a URL/ID-safe string.
 * "Eligibility Criteria" → "eligibility-criteria"
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Parse raw markdown text into an array of `DocumentSection` objects.
 *
 * Sections are delimited by ATX headings (`#`, `##`, `###`).
 * Content before the first heading becomes a preamble section (level 0).
 * Each section includes its heading line and all body lines up to (but not
 * including) the next heading of any level.
 *
 * If the document contains exactly one `#` heading (typically a document title),
 * that heading is not treated as a section boundary — sections start from `##`.
 *
 * @param maxLevel Maximum heading depth to split on (2 = `##` only, 3 = `##` and `###`). Defaults to 3.
 */
export function parseMarkdownSections(text: string, maxLevel = 3): DocumentSection[] {
  const lines = text.split("\n");

  // Pre-scan: count how many `#` (level-1) headings exist.
  // If there's exactly one, it's a document title — skip it as a section delimiter.
  const h1Count = lines.filter((l) => /^#\s+/.test(l) && !/^##/.test(l)).length;
  const minLevel = h1Count === 1 ? 2 : 1;
  // Clamp to safe integer range [1,3] to prevent ReDoS via non-literal RegExp
  const clampedMax = Math.max(1, Math.min(Math.floor(maxLevel), 3));
  const effectiveMax = Math.max(minLevel, clampedMax);
  // nosemgrep: detect-non-literal-regexp — minLevel and effectiveMax are clamped integers in [1,3], no user-controlled input
  const headingRe = new RegExp(`^(#{${minLevel},${effectiveMax}})\\s+(.+)$`);

  const sections: DocumentSection[] = [];

  /** Index where the current section starts. */
  let currentStart = 0;
  /** Heading level of the current section (0 = preamble). */
  let currentLevel = 0;
  /** Title of the current section. */
  let currentTitle = "(Preamble)";
  /** Running section counter for stable ID generation. */
  let sectionIndex = 0;

  function pushSection(endLine: number): void {
    // Skip empty preamble (no content before first heading)
    if (currentLevel === 0 && currentStart === endLine) return;

    const content = lines.slice(currentStart, endLine).join("\n");
    // Also skip preamble that's only whitespace
    if (currentLevel === 0 && content.trim().length === 0) return;

    const id = `s${sectionIndex}-${slugify(currentTitle) || "untitled"}`;
    sections.push({
      id,
      title: currentTitle,
      level: currentLevel,
      startLine: currentStart,
      endLine,
      content,
    });
    sectionIndex++;
  }

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(headingRe);
    if (!match) continue;

    // Close the previous section
    pushSection(i);

    // Start a new section
    currentStart = i;
    currentLevel = match[1].length;
    currentTitle = match[2].trim();
  }

  // Close the final section
  pushSection(lines.length);

  return sections;
}

/** Default maximum section size in characters before paragraph subdivision. */
const MAX_SECTION_SIZE = 4000;

/**
 * Subdivide sections that exceed `maxSize` characters at paragraph boundaries
 * (double-newline). Sub-sections get IDs like `s3-eligibility-p1`, `s3-eligibility-p2`.
 *
 * Sections at or under the limit are returned unchanged.
 */
export function subdivideLargeSections(
  sections: DocumentSection[],
  maxSize = MAX_SECTION_SIZE,
): DocumentSection[] {
  const result: DocumentSection[] = [];

  for (const section of sections) {
    if (section.content.length <= maxSize) {
      result.push(section);
      continue;
    }

    // Split on paragraph boundaries (double newline)
    const paragraphs = section.content.split(/\n\n+/);
    let currentChunk = "";
    let chunkStartLine = section.startLine;
    let lineOffset = section.startLine;
    let partIndex = 0;

    for (let i = 0; i < paragraphs.length; i++) {
      const para = paragraphs[i];
      const separator = currentChunk.length > 0 ? "\n\n" : "";
      const candidate = currentChunk + separator + para;

      if (candidate.length > maxSize && currentChunk.length > 0) {
        // Flush current chunk as a sub-section
        result.push({
          id: `${section.id}-p${partIndex}`,
          title: partIndex === 0 ? section.title : `${section.title} (cont.)`,
          level: section.level,
          startLine: chunkStartLine,
          endLine: lineOffset,
          content: currentChunk,
        });
        partIndex++;
        chunkStartLine = lineOffset;
        currentChunk = para;
      } else {
        currentChunk = candidate;
      }

      // Count lines in this paragraph + the separator
      const paraLines = para.split("\n").length;
      const sepLines = i > 0 ? 1 : 0; // double-newline = at least 1 blank line
      lineOffset += paraLines + sepLines;
    }

    // Flush remaining content
    if (currentChunk.length > 0) {
      result.push({
        id: partIndex === 0 ? section.id : `${section.id}-p${partIndex}`,
        title: partIndex === 0 ? section.title : `${section.title} (cont.)`,
        level: section.level,
        startLine: chunkStartLine,
        endLine: section.endLine,
        content: currentChunk,
      });
    }
  }

  return result;
}
