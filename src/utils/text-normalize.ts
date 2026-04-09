/**
 * Text normalization and tokenization utilities for fuzzy statement matching.
 */

/**
 * Normalize text for comparison: lowercase, collapse whitespace,
 * strip punctuation except hyphens within words.
 */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/[^\w\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tokenize text into lowercase words, stripping punctuation.
 * Keeps hyphenated words intact (e.g., "under-16s" → "under-16s").
 */
export function tokenize(text: string): string[] {
  return normalizeForMatch(text)
    .split(/\s+/)
    .filter((w) => w.length > 0);
}
