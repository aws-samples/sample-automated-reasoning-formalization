/**
 * Pure functions for building test analysis prompts and computing
 * document highlight filters from test findings.
 *
 * These have no side effects and no dependencies on app state.
 */
import type { TestCaseWithResult, PolicyDefinition } from '../types';
import { toAppDefinition } from '../utils/policy-definition';
import type { AutomatedReasoningPolicyDefinition } from '@aws-sdk/client-bedrock';
import { extractRelevantRuleIds, extractRelevantVariables } from './test-findings';

/**
 * Build a prompt that gives the agent full context about a test case
 * so it can explain what the test checks and why it's passing or failing.
 *
 * @param compactMode When true, adds hints about using search tools to access
 *   policy details not included in the compact context.
 */
export function buildTestAnalysisPrompt(test: TestCaseWithResult, compactMode = false): string {
  const expected = test.testCase.expectedAggregatedFindingsResult ?? 'unknown';
  const actual = test.aggregatedTestFindingsResult ?? 'Not yet run';
  const passed = actual !== 'Not yet run' && actual === expected;
  const hasRun = actual !== 'Not yet run';

  const lines = [
    `[TEST ANALYSIS]`,
    `Answer (guard content): ${test.testCase.guardContent ?? ''}`,
    test.testCase.queryContent ? `Question (query content): ${test.testCase.queryContent}` : '',
    `Expected result: ${expected}`,
    `Actual result: ${actual}`,
    test.testFindings ? `Findings: ${JSON.stringify(test.testFindings)}` : '',
    ``,
    `Analyze this test. Explain what it's checking in plain language.`,
  ];

  if (!hasRun) {
    lines.push(`This test has not been run yet. Explain what it validates and suggest running it.`);
  } else if (passed) {
    lines.push(`Explain why it's passing and suggest a logical next step.`);
  } else {
    lines.push(
      `This test is FAILING. The user expected ${expected} but got ${actual}.`,
      `Diagnose the root cause by working through: (1) rule logic — do the rules match the source document for this scenario? Check for missing rules, wrong thresholds, or reversed implications. (2) variable coverage — are all concepts modeled? (3) translation layer — did variable descriptions capture the test language?`,
      `Check for untranslated content (untranslatedPremises or untranslatedClaims) and explain what's missing.`,
    );

    // Add targeted hint for the most common misdiagnosed failure mode
    if (actual === 'SATISFIABLE' && expected === 'VALID') {
      lines.push(
        ``,
        `SATISFIABLE means the policy allows the claim but doesn't guarantee it. Check whether existing rules use the wrong implication direction. A rule like (=> autoApproved (<= amount 100)) means "if autoApproved then amount ≤ 100" — it does NOT mean "if amount ≤ 100 then autoApproved." You likely need to add the missing forward implication as a new rule.`,
      );
    }

    lines.push(
      ``,
      `You MUST offer multiple remediation paths. Emit follow-up-prompt cards with 2–4 distinct options. Strategies in order of preference:`,
      `- Add or update rules if the policy logic doesn't match the source document for this scenario`,
      `- Add missing variables if the test references concepts the policy doesn't model`,
      `- Improve variable descriptions only if rules are correct but the translation layer can't map input text`,
      `- Rewrite the test text to be more explicit (last resort)`,
    );
  }

  if (compactMode) {
    lines.push(
      ``,
      `NOTE: This policy is large. You are seeing pre-selected context for this test. ` +
      `Use the search tools (search_rules, search_variables, get_section_rules, search_document, ` +
      `get_rule_details, get_variable_details, find_related_content) to access additional ` +
      `policy details as needed. These tools are read-only and do not require approval.`,
    );
  }

  return lines.filter(Boolean).join('\n');
}

export interface TestHighlightResult {
  directRuleIds: string[];
  inferredRuleIds: string[];
  variables: string[];
  hasFilter: boolean;
}

/**
 * Compute which rules and variables should be highlighted in the document
 * preview based on a test's findings. Returns the filter data without
 * applying it — the caller decides how to use it.
 */
export function computeTestHighlightFilter(
  test: TestCaseWithResult,
  definition: AutomatedReasoningPolicyDefinition | null,
): TestHighlightResult {
  const empty: TestHighlightResult = { directRuleIds: [], inferredRuleIds: [], variables: [], hasFilter: false };

  if (!test.testFindings || test.testFindings.length === 0) {
    return empty;
  }

  const directRuleIds = extractRelevantRuleIds(test.testFindings);

  let inferredRuleIds: string[] = [];
  let variables: string[] = [];
  if (definition) {
    const def = toAppDefinition(definition);
    variables = extractRelevantVariables(
      test.testFindings,
      def,
    );
    if (variables.length > 0) {
      const varSet = new Set(variables);
      for (const rule of def.rules) {
        for (const varName of varSet) {
          if (rule.expression.includes(varName)) {
            inferredRuleIds.push(rule.ruleId);
            break;
          }
        }
      }
    }
  }

  const hasFilter = directRuleIds.length > 0 || inferredRuleIds.length > 0 || variables.length > 0;
  return { directRuleIds, inferredRuleIds, variables, hasFilter };
}
