/**
 * Card parsing utilities — shared between ChatPanel (streaming) and
 * ChatService (post-hoc extraction).
 *
 * Pure functions with no side effects. Parses JSON-fenced and XML-style
 * card blocks from agent response text into typed ChatCard objects.
 */
import type { ChatCard } from '../types';

/** Known card type strings from the ChatCard union */
export const KNOWN_CARD_TYPES = new Set([
  'rule', 'test', 'next-steps',
  'variable-proposal', 'guardrail-validation', 'follow-up-prompt',
  'proposal',
]);

/** Regex for ```json fenced card blocks */
export const JSON_CARD_RE = /```json\s*\n([\s\S]*?)\n```/g;

/** Regex for <card type="...">...</card> XML-style card blocks */
export const XML_CARD_RE = /<card\b[^>]*>[\s\S]*?<\/card>/g;

/**
 * Parse an XML-style <card> block into a ChatCard object.
 * Extracts the type from the <card> attribute and child elements as fields.
 */
export function parseXmlCard(xml: string): ChatCard | null {
  const typeMatch = xml.match(/<card\s+type="([^"]+)"/);
  if (!typeMatch) return null;

  const cardType = typeMatch[1];
  const fields: Record<string, string> = {};

  // Strip the outer <card ...> and </card> tags to get inner content only
  const inner = xml.replace(/<card\b[^>]*>/, '').replace(/<\/card>\s*$/, '');

  // Extract child elements: <tagName>content</tagName>
  const fieldPattern = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let fieldMatch: RegExpExecArray | null;
  while ((fieldMatch = fieldPattern.exec(inner)) !== null) {
    fields[fieldMatch[1]] = fieldMatch[2].trim();
  }

  // Map XML fields to the appropriate ChatCard shape based on type
  switch (cardType) {
    case 'rule':
      return {
        type: 'rule',
        ruleId: fields.ruleId ?? '',
        expression: fields.expression ?? '',
        naturalLanguage: fields.naturalLanguage ?? fields.description ?? fields.title ?? '',
      };
    case 'test':
      return {
        type: 'test',
        testId: fields.testId ?? '',
        answer: fields.answer ?? fields.prompt ?? '',
        question: fields.question ?? fields.output ?? '',
        expectedStatus: fields.expectedStatus ?? '',
        actualStatus: fields.actualStatus ?? '',
        findingsSummary: fields.findingsSummary ?? fields.findings ?? '',
      };
    case 'next-steps':
      return {
        type: 'next-steps',
        summary: fields.summary ?? '',
        description: fields.description ?? '',
        prompt: fields.prompt ?? '',
      };
    case 'follow-up-prompt':
      return {
        type: 'follow-up-prompt',
        label: fields.label ?? '',
        prompt: fields.prompt ?? '',
      };
    default:
      // For unknown types, try to return a generic shape with the type field
      return { type: cardType, ...fields } as unknown as ChatCard;
  }
}

/**
 * Extract all card blocks (JSON and XML) from agent response text.
 * Returns the parsed cards and the text with card blocks removed.
 */
export function extractCards(text: string): {
  cards: ChatCard[];
  text: string;
  positions: { start: number; end: number }[];
} {
  // Collect all card blocks with their positions in the raw text
  const found: { start: number; end: number; card: ChatCard }[] = [];

  // 1. JSON fenced blocks
  let match: RegExpExecArray | null;
  const jsonRe = new RegExp(JSON_CARD_RE.source, 'g');
  while ((match = jsonRe.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.type) {
        found.push({ start: match.index, end: match.index + match[0].length, card: parsed as ChatCard });
      }
    } catch {
      // Not a valid card JSON — leave in text
    }
  }

  // 2. XML-style <card> blocks
  const xmlRe = new RegExp(XML_CARD_RE.source, 'g');
  while ((match = xmlRe.exec(text)) !== null) {
    const card = parseXmlCard(match[0]);
    if (card) {
      found.push({ start: match.index, end: match.index + match[0].length, card });
    }
  }

  // 3. Recover trailing partial card block (agent response cut off mid-card)
  const partialIdx = findPartialCardStart(text);
  if (partialIdx !== -1) {
    const alreadyCovered = found.some(
      (f) => f.start <= partialIdx && f.end > partialIdx
    );
    if (!alreadyCovered) {
      const afterFence = text.indexOf('\n', partialIdx);
      if (afterFence !== -1) {
        const jsonFragment = text.slice(afterFence + 1).replace(/\n?```\s*$/, '').trim();
        let parsed: Record<string, unknown> | null = null;
        for (const suffix of ['', '}', '"}', '"]}']) {
          try { parsed = JSON.parse(jsonFragment + suffix); break; } catch { /* Try next suffix — progressive JSON repair */ }
        }
        if (parsed?.type) {
          found.push({ start: partialIdx, end: text.length, card: parsed as unknown as ChatCard });
        }
      }
    }
  }

  // Sort by position so cards and positions stay in sync
  found.sort((a, b) => a.start - b.start);

  // Build cleaned text and aligned cards + positions arrays
  const cards: ChatCard[] = [];
  const positions: { start: number; end: number }[] = [];
  let cleaned = '';
  let cursor = 0;
  for (const f of found) {
    cleaned += text.slice(cursor, f.start);
    const posStart = cleaned.length;
    positions.push({ start: posStart, end: posStart });
    cards.push(f.card);
    cursor = f.end;
  }
  cleaned += text.slice(cursor);

  return { cards, text: cleaned.trim(), positions };
}

/**
 * Strip card blocks (JSON and XML) from text for display during streaming.
 * Does not parse — just removes the blocks so they don't render as code.
 */
export function stripCardBlocks(text: string): string {
  return text
    .replace(JSON_CARD_RE, '')
    .replace(XML_CARD_RE, '')
    .trim();
}

/**
 * Find the start index of an incomplete card block at the tail of `text`.
 * Returns -1 if there is no partial block in progress.
 *
 * Detects:
 *  - An opening ` ```json ` fence without a matching closing ` ``` `
 *  - An opening `<card` tag without a matching `</card>`
 *
 * This lets the streaming display buffer text that might become a card
 * instead of flashing raw code to the user.
 */
export function findPartialCardStart(text: string): number {
  // Look for the last opening ```json fence
  const jsonOpenIdx = text.lastIndexOf('```json');
  if (jsonOpenIdx !== -1) {
    // Check if there's a closing ``` after the opening fence content
    const afterOpen = text.indexOf('\n', jsonOpenIdx);
    if (afterOpen !== -1) {
      // Look for a closing ``` that isn't the opening one
      const closingIdx = text.indexOf('\n```', afterOpen);
      if (closingIdx === -1) {
        // No closing fence yet — this is a partial card block
        return jsonOpenIdx;
      }
    } else {
      // Opening fence with no newline yet — still partial
      return jsonOpenIdx;
    }
  }

  // Look for the last opening <card tag
  const xmlOpenIdx = text.lastIndexOf('<card');
  if (xmlOpenIdx !== -1) {
    const closingIdx = text.indexOf('</card>', xmlOpenIdx);
    if (closingIdx === -1) {
      return xmlOpenIdx;
    }
  }

  return -1;
}
