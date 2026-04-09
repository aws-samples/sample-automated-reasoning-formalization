/**
 * Stream parser — pure function for detecting card boundaries in raw text.
 *
 * Extracted from useStreamProcessor so it can be shared by ChatContextRouter.
 * No side effects — the caller provides a nextId function for segment IDs.
 */
import type { ChatCard } from "../types";
import type { ChatSegment } from "../hooks/useStreamProcessor";
import { KNOWN_CARD_TYPES, parseXmlCard } from "./card-parser";

/**
 * Process raw text to find complete card blocks and split into segments.
 * Pure function — no side effects.
 */
export function processRaw(
  raw: string,
  processedUpTo: number,
  currentTextContent: string,
  batchId: string,
  nextId: () => string,
): { segments: ChatSegment[]; newProcessedUpTo: number; newTextContent: string; hasPartial: boolean } {
  const segments: ChatSegment[] = [];
  let searchFrom = processedUpTo;
  let textContent = currentTextContent;
  let foundBlock = true;

  while (foundBlock) {
    foundBlock = false;
    const remaining = raw.slice(searchFrom);

    const jsonMatch = remaining.match(/```json\s*\n([\s\S]*?)\n```/);
    const xmlMatch = remaining.match(/<card\b[^>]*>[\s\S]*?<\/card>/);

    let match: { start: number; end: number; content: string; isXml: boolean } | null = null;
    if (jsonMatch && xmlMatch) {
      match = jsonMatch.index! <= xmlMatch.index!
        ? { start: searchFrom + jsonMatch.index!, end: searchFrom + jsonMatch.index! + jsonMatch[0].length, content: jsonMatch[1], isXml: false }
        : { start: searchFrom + xmlMatch.index!, end: searchFrom + xmlMatch.index! + xmlMatch[0].length, content: xmlMatch[0], isXml: true };
    } else if (jsonMatch) {
      match = { start: searchFrom + jsonMatch.index!, end: searchFrom + jsonMatch.index! + jsonMatch[0].length, content: jsonMatch[1], isXml: false };
    } else if (xmlMatch) {
      match = { start: searchFrom + xmlMatch.index!, end: searchFrom + xmlMatch.index! + xmlMatch[0].length, content: xmlMatch[0], isXml: true };
    }

    if (!match) break;
    foundBlock = true;

    let card: ChatCard | null = null;
    if (match.isXml) {
      card = parseXmlCard(match.content);
    } else {
      try {
        const parsed = JSON.parse(match.content);
        if (parsed?.type && KNOWN_CARD_TYPES.has(parsed.type)) card = parsed as ChatCard;
      } catch { /* not a card */ }
    }

    if (card) {
      const textBefore = raw.slice(processedUpTo, match.start);
      textContent += textBefore;
      if (textContent.trim()) {
        segments.push({ id: nextId(), type: "text", content: textContent });
      }
      segments.push({ id: nextId(), type: "card", content: "", card, batchId });
      textContent = "";
      processedUpTo = match.end;
      searchFrom = match.end;
    } else {
      const textIncluding = raw.slice(processedUpTo, match.end);
      textContent += textIncluding;
      processedUpTo = match.end;
      searchFrom = match.end;
    }
  }

  // Check for partial block in trailing text
  const trailing = raw.slice(processedUpTo);
  const hasPartialJson = trailing.lastIndexOf("```json") !== -1;
  const hasPartialXml = trailing.lastIndexOf("<card") !== -1 && trailing.indexOf("</card>") === -1;
  const hasPartial = hasPartialJson || hasPartialXml;

  return { segments, newProcessedUpTo: processedUpTo, newTextContent: textContent, hasPartial };
}
