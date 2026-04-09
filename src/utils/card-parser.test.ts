/**
 * Tests for card-parser utilities — parseXmlCard, extractCards,
 * stripCardBlocks, findPartialCardStart, and KNOWN_CARD_TYPES.
 */
import { describe, it, expect } from 'vitest';
import {
  parseXmlCard,
  extractCards,
  stripCardBlocks,
  findPartialCardStart,
  KNOWN_CARD_TYPES,
} from './card-parser';

describe('KNOWN_CARD_TYPES', () => {
  it('contains all expected card types', () => {
    expect(KNOWN_CARD_TYPES.has('rule')).toBe(true);
    expect(KNOWN_CARD_TYPES.has('test')).toBe(true);
    expect(KNOWN_CARD_TYPES.has('next-steps')).toBe(true);
    expect(KNOWN_CARD_TYPES.has('variable-proposal')).toBe(true);
    expect(KNOWN_CARD_TYPES.has('guardrail-validation')).toBe(true);
    expect(KNOWN_CARD_TYPES.has('follow-up-prompt')).toBe(true);
    expect(KNOWN_CARD_TYPES.has('proposal')).toBe(true);
  });

  it('does not contain unknown types', () => {
    expect(KNOWN_CARD_TYPES.has('unknown')).toBe(false);
  });
});

describe('parseXmlCard', () => {
  it('parses a rule card', () => {
    const xml = '<card type="rule"><ruleId>r1</ruleId><expression>x > 0</expression><naturalLanguage>x must be positive</naturalLanguage></card>';
    const card = parseXmlCard(xml);
    expect(card).toEqual({
      type: 'rule',
      ruleId: 'r1',
      expression: 'x > 0',
      naturalLanguage: 'x must be positive',
    });
  });

  it('falls back to description field for rule naturalLanguage', () => {
    const xml = '<card type="rule"><ruleId>r2</ruleId><expression>y</expression><description>desc</description></card>';
    const card = parseXmlCard(xml);
    expect(card).toEqual({
      type: 'rule',
      ruleId: 'r2',
      expression: 'y',
      naturalLanguage: 'desc',
    });
  });

  it('falls back to title field for rule naturalLanguage', () => {
    const xml = '<card type="rule"><ruleId>r3</ruleId><expression>z</expression><title>ttl</title></card>';
    const card = parseXmlCard(xml);
    expect(card!.type).toBe('rule');
    expect((card as any).naturalLanguage).toBe('ttl');
  });

  it('parses a test card', () => {
    const xml = '<card type="test"><testId>t1</testId><answer>q</answer><question>a</question><expectedStatus>PASS</expectedStatus><actualStatus>FAIL</actualStatus><findingsSummary>bad</findingsSummary></card>';
    const card = parseXmlCard(xml);
    expect(card).toEqual({
      type: 'test',
      testId: 't1',
      answer: 'q',
      question: 'a',
      expectedStatus: 'PASS',
      actualStatus: 'FAIL',
      findingsSummary: 'bad',
    });
  });

  it('falls back to findings field for test findingsSummary', () => {
    const xml = '<card type="test"><testId>t2</testId><answer>q</answer><question>a</question><expectedStatus>PASS</expectedStatus><actualStatus>PASS</actualStatus><findings>ok</findings></card>';
    const card = parseXmlCard(xml);
    expect(card!.type).toBe('test');
    expect((card as any).findingsSummary).toBe('ok');
  });

  it('parses a next-steps card', () => {
    const xml = '<card type="next-steps"><summary>s</summary><description>d</description><prompt>p</prompt></card>';
    const card = parseXmlCard(xml);
    expect(card).toEqual({
      type: 'next-steps',
      summary: 's',
      description: 'd',
      prompt: 'p',
    });
  });

  it('parses a follow-up-prompt card', () => {
    const xml = '<card type="follow-up-prompt"><label>lbl</label><prompt>do it</prompt></card>';
    const card = parseXmlCard(xml);
    expect(card).toEqual({
      type: 'follow-up-prompt',
      label: 'lbl',
      prompt: 'do it',
    });
  });

  it('returns null for missing type attribute', () => {
    expect(parseXmlCard('<card><ruleId>r</ruleId></card>')).toBeNull();
  });

  it('returns null for non-card XML', () => {
    expect(parseXmlCard('<div>hello</div>')).toBeNull();
  });

  it('handles unknown card types with generic shape', () => {
    const xml = '<card type="custom"><foo>bar</foo></card>';
    const card = parseXmlCard(xml);
    expect(card).toBeTruthy();
    expect(card!.type).toBe('custom');
    expect((card as any).foo).toBe('bar');
  });

  it('trims whitespace from field values', () => {
    const xml = '<card type="rule"><ruleId>  r1  </ruleId><expression> x </expression><naturalLanguage> nl </naturalLanguage></card>';
    const card = parseXmlCard(xml);
    expect(card).toEqual({
      type: 'rule',
      ruleId: 'r1',
      expression: 'x',
      naturalLanguage: 'nl',
    });
  });

  it('defaults missing fields to empty strings', () => {
    const xml = '<card type="rule"></card>';
    const card = parseXmlCard(xml);
    expect(card).toEqual({
      type: 'rule',
      ruleId: '',
      expression: '',
      naturalLanguage: '',
    });
  });
});

describe('extractCards', () => {
  it('extracts JSON fenced card blocks', () => {
    const text = 'Hello\n```json\n{"type":"rule","ruleId":"r1","expression":"x","naturalLanguage":"nl"}\n```\nWorld';
    const result = extractCards(text);
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].type).toBe('rule');
    expect(result.text).toBe('Hello\n\nWorld');
  });

  it('extracts XML card blocks', () => {
    const text = 'Before <card type="rule"><ruleId>r1</ruleId><expression>x</expression><naturalLanguage>nl</naturalLanguage></card> After';
    const result = extractCards(text);
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].type).toBe('rule');
    expect(result.text).toBe('Before  After');
  });

  it('extracts multiple cards', () => {
    const text = '<card type="rule"><ruleId>r1</ruleId><expression>x</expression><naturalLanguage>nl</naturalLanguage></card>\n<card type="test"><testId>t1</testId><answer>q</answer><question>a</question><expectedStatus>P</expectedStatus><actualStatus>P</actualStatus><findingsSummary>ok</findingsSummary></card>';
    const result = extractCards(text);
    expect(result.cards).toHaveLength(2);
    expect(result.cards[0].type).toBe('rule');
    expect(result.cards[1].type).toBe('test');
  });

  it('returns empty cards for text without card blocks', () => {
    const result = extractCards('Just plain text');
    expect(result.cards).toHaveLength(0);
    expect(result.text).toBe('Just plain text');
  });

  it('ignores invalid JSON in fenced blocks', () => {
    const text = '```json\n{not valid json}\n```';
    const result = extractCards(text);
    expect(result.cards).toHaveLength(0);
  });

  it('ignores JSON without type field', () => {
    const text = '```json\n{"name":"foo"}\n```';
    const result = extractCards(text);
    expect(result.cards).toHaveLength(0);
  });

  it('returns positions aligned with cleaned text', () => {
    const text = 'A <card type="rule"><ruleId>r</ruleId><expression>e</expression><naturalLanguage>n</naturalLanguage></card> B';
    const result = extractCards(text);
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].start).toBe(2); // after "A "
  });
});

describe('stripCardBlocks', () => {
  it('strips JSON fenced card blocks', () => {
    const text = 'Hello\n```json\n{"type":"rule"}\n```\nWorld';
    expect(stripCardBlocks(text)).toBe('Hello\n\nWorld');
  });

  it('strips XML card blocks', () => {
    const text = 'Before <card type="rule"><ruleId>r</ruleId></card> After';
    expect(stripCardBlocks(text)).toBe('Before  After');
  });

  it('returns trimmed text when no card blocks', () => {
    expect(stripCardBlocks('  hello  ')).toBe('hello');
  });
});

describe('findPartialCardStart', () => {
  it('detects partial JSON fence', () => {
    const text = 'Hello\n```json\n{"type":"ru';
    expect(findPartialCardStart(text)).toBe(6);
  });

  it('detects partial XML card', () => {
    const text = 'Hello <card type="rule"><ruleId>r';
    expect(findPartialCardStart(text)).toBe(6);
  });

  it('returns -1 for complete JSON fence', () => {
    const text = '```json\n{"type":"rule"}\n```';
    expect(findPartialCardStart(text)).toBe(-1);
  });

  it('returns -1 for complete XML card', () => {
    const text = '<card type="rule"><ruleId>r</ruleId></card>';
    expect(findPartialCardStart(text)).toBe(-1);
  });

  it('returns -1 for text without card blocks', () => {
    expect(findPartialCardStart('Just text')).toBe(-1);
  });

  it('detects partial JSON fence with no newline after opening', () => {
    const text = '```json';
    expect(findPartialCardStart(text)).toBe(0);
  });
});
