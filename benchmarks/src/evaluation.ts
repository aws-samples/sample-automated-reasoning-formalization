/**
 * Evaluation — deterministic metrics and LLM-as-judge scoring.
 *
 * The LLM judge uses Claude Opus 4.6 via Bedrock InvokeModel to evaluate
 * whether the agent's policy changes are generalizable or overfitting.
 *
 * Changes are grouped by iteration so the judge can evaluate related actions
 * together (e.g., adding a variable then creating a rule that uses it).
 */
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-providers";
import type {
  RepairSession,
  RepairIteration,
  DeterministicEvaluation,
  JudgeEvaluation,
  ChangeAssessment,
} from "./types";

const JUDGE_MODEL_ID = "us.anthropic.claude-opus-4-6-v1";

// ── Deterministic evaluation ──

export function computeDeterministicEvaluation(
  session: RepairSession,
): DeterministicEvaluation {
  const { iterations } = session;
  if (iterations.length === 0) {
    return {
      allTestsPassed: false, iterationsToConverge: 0, perTestConvergence: [],
      totalLatencyMs: 0, perIterationLatencyMs: [], totalToolCalls: 0,
      totalBuildErrors: 0, noOpIterations: 0,
    };
  }

  const allTestIds = iterations[0].testResults.map(r => ({
    testCaseId: r.testCaseId, fixtureTestId: r.fixtureTestId,
  }));

  const perTestConvergence = allTestIds.map(({ testCaseId, fixtureTestId }) => {
    let firstPassed: number | null = null;
    for (const iter of iterations) {
      const result = iter.testResults.find(r => r.testCaseId === testCaseId);
      if (result?.passed) { firstPassed = iter.iteration; break; }
    }
    return { testCaseId, fixtureTestId, firstPassedAtIteration: firstPassed };
  });

  return {
    allTestsPassed: session.converged,
    iterationsToConverge: session.converged
      ? iterations[iterations.length - 1].iteration
      : iterations.length - 1,
    perTestConvergence,
    totalLatencyMs: session.totalLatencyMs,
    perIterationLatencyMs: iterations.map(i => i.latencyMs),
    totalToolCalls: iterations.reduce((sum, iter) => sum + iter.toolCalls.length, 0),
    totalBuildErrors: iterations.filter(i => i.buildErrorOccurred).length,
    noOpIterations: iterations.filter(i => i.iteration > 0 && !i.proposalEmitted).length,
  };
}

// ── LLM-as-Judge evaluation ──

/**
 * Evaluate the agent's changes using Claude Opus 4.6 as a judge.
 *
 * Changes are grouped by iteration so the judge sees the full picture
 * (e.g., "add variable" + "add rule using that variable" evaluated together).
 */
export async function evaluateWithJudge(
  session: RepairSession,
  sourceDocumentText: string,
  originalDefinition: Record<string, unknown>,
  log: (msg: string) => void,
  region?: string,
): Promise<JudgeEvaluation> {
  log("Running LLM-as-judge evaluation (Claude Opus 4.6)…");

  const client = new BedrockRuntimeClient({
    region: region ?? process.env.AWS_REGION ?? "us-west-2",
    credentials: fromIni(),
  });

  // Group changes by iteration — evaluate all changes in an iteration together
  const iterationsWithChanges = session.iterations.filter(
    iter => iter.iteration > 0 && iter.proposalCards.length > 0,
  );

  if (iterationsWithChanges.length === 0) {
    log("No proposal cards with changes found — nothing to evaluate.");
    for (const iter of session.iterations) {
      if (iter.iteration === 0) continue;
      log(`  Iteration ${iter.iteration}: ${iter.proposalCards.length} proposal card(s), proposalEmitted=${iter.proposalEmitted}`);
    }
    return { changes: [], overallScore: 0, summary: "No policy changes were made." };
  }

  log(`Evaluating ${iterationsWithChanges.length} iteration(s) with changes…`);
  const assessments: ChangeAssessment[] = [];

  for (const iter of iterationsWithChanges) {
    // Collect ALL changes from ALL proposals in this iteration as a group
    const allChanges = iter.proposalCards.flatMap(p => p.changes);
    const groupDescription = allChanges
      .map(c => `${c.label}: ${c.before ?? "(none)"} → ${c.after}`)
      .join("\n");

    // Find the test that motivated this iteration
    const prevIter = session.iterations.find(i => i.iteration === iter.iteration - 1)
      ?? session.iterations[0];
    const failingTest = prevIter.testResults.find(r => !r.passed);

    try {
      log(`  Iteration ${iter.iteration} (${allChanges.length} changes, target: ${iter.targetFixtureTestId})…`);
      const assessment = await evaluateChangeGroup(
        client, groupDescription, iter, failingTest, sourceDocumentText, originalDefinition, log,
      );
      assessments.push(assessment);
      log(`    → ${assessment.generalizability} (${assessment.paraphraseRobustness}), root cause: ${assessment.rootCauseAddressed}`);
    } catch (err) {
      log(`  ✗ Judge call failed for iteration ${iter.iteration}: ${(err as Error).message}`);
      assessments.push({
        changeDescription: groupDescription,
        iteration: iter.iteration,
        generalizability: "unclear",
        paraphraseRobustness: "unknown",
        rootCauseAddressed: false,
        reasoning: `Judge evaluation failed: ${(err as Error).message}`,
      });
    }
  }

  const scoreMap = { generalizable: 5, unclear: 3, likely_overfitting: 1 };
  const totalScore = assessments.reduce((sum, a) => sum + (scoreMap[a.generalizability] ?? 3), 0);
  const overallScore = assessments.length > 0 ? totalScore / assessments.length : 0;
  const genCount = assessments.filter(a => a.generalizability === "generalizable").length;
  const overfitCount = assessments.filter(a => a.generalizability === "likely_overfitting").length;

  const summary = `Evaluated ${assessments.length} change groups using Claude Opus 4.6. ${genCount} generalizable, ${overfitCount} overfitting, ${assessments.length - genCount - overfitCount} unclear.`;
  log(summary);

  return { changes: assessments, overallScore, summary };
}

async function evaluateChangeGroup(
  client: BedrockRuntimeClient,
  groupDescription: string,
  iter: RepairIteration,
  failingTest: { guardContent: string; queryContent: string; expectedResult: string } | undefined,
  sourceDocumentText: string,
  originalDefinition: Record<string, unknown>,
  log: (msg: string) => void,
): Promise<ChangeAssessment> {
  const prompt = buildJudgePrompt(
    groupDescription, iter, failingTest, sourceDocumentText, originalDefinition,
  );

  const response = await client.send(new InvokeModelCommand({
    modelId: JUDGE_MODEL_ID,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 1024,
      temperature: 0.1,
      messages: [{ role: "user", content: prompt }],
      system: "You are an expert evaluator of Automated Reasoning policy changes for a system that validates LLM-generated answers in real time. You assess whether fixes to policy rules are generalizable or overfitting to specific test cases. Always respond with a single JSON object matching the requested schema. No prose outside the JSON.",
    }),
  }));

  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  const text = responseBody.content?.[0]?.text ?? "";

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Judge did not return valid JSON: ${text.slice(0, 200)}`);

  const parsed = JSON.parse(jsonMatch[0]);
  const validGen = ["generalizable", "likely_overfitting", "unclear"];
  const validRob = ["robust", "fragile", "unknown"];

  return {
    changeDescription: groupDescription,
    iteration: iter.iteration,
    generalizability: validGen.includes(parsed.generalizability) ? parsed.generalizability : "unclear",
    paraphraseRobustness: validRob.includes(parsed.paraphraseRobustness) ? parsed.paraphraseRobustness : "unknown",
    rootCauseAddressed: parsed.rootCauseAddressed === true,
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "No reasoning provided.",
  };
}

function buildJudgePrompt(
  groupDescription: string,
  iter: RepairIteration,
  failingTest: { guardContent: string; queryContent: string; expectedResult: string } | undefined,
  sourceDocumentText: string,
  originalDefinition: Record<string, unknown>,
): string {
  const docExcerpt = sourceDocumentText.length > 3000
    ? sourceDocumentText.slice(0, 3000) + "\n\n[… truncated …]"
    : sourceDocumentText;

  const defSummary = JSON.stringify({
    rules: (originalDefinition as any).rules?.slice(0, 20),
    variables: (originalDefinition as any).variables?.slice(0, 20),
  }, null, 2);

  // Summarize tool calls for context
  const toolCallSummary = iter.toolCalls
    .filter(tc => tc.title && !tc.title.includes("execute_tests"))
    .map(tc => `- ${tc.title}: ${tc.input ? JSON.stringify(tc.input).slice(0, 300) : "(no input captured)"}`)
    .join("\n") || "(no mutating tool calls observed)";

  return `You are evaluating a GROUP of changes made by an AI agent in a single iteration to fix a failing test case in an Automated Reasoning policy.

## Important Context: How This System Works

This policy is used in a REAL-TIME answer validation system. When an LLM generates an answer to a user's question, the Automated Reasoning system translates the answer and question into formal logic variables, then checks whether the answer is consistent with the policy rules.

Key implications for your evaluation:
- **Translation quality matters**: Variable descriptions determine how well natural language maps to formal logic. Improving descriptions is often the right fix for TRANSLATION_AMBIGUOUS failures.
- **Test rewrites can be valid fixes**: If a test's answer text contains genuinely ambiguous or untranslatable language, rewriting the test to be clearer is a VALID fix — it reflects what the production system would actually encounter. The system rewrites answers in real time, so tests should use language that the translation layer can handle.
- **Evaluate the group as a whole**: The agent may add a variable in one step and then create a rule using that variable in the next step. These are RELATED actions that should be evaluated together. A variable addition alone is incomplete, but variable + rule together may be a complete, generalizable fix.

## Source Document (ground truth)
${docExcerpt}

## Original Policy Definition (before changes)
${defSummary}

## All Changes Made in This Iteration (evaluate as a group)
${groupDescription}

## Tool Calls Made
${toolCallSummary}

## Test Case That Motivated These Changes
- Answer (guard content): ${failingTest?.guardContent ?? "(unknown)"}
- Question (query content): ${failingTest?.queryContent ?? "(unknown)"}
- Expected result: ${failingTest?.expectedResult ?? "(unknown)"}

## Evaluation Criteria

Consider the ENTIRE group of changes together:
1. Do the changes, taken together, correctly address the policy deficiency?
2. Would the combined changes produce correct results for paraphrased versions of the test?
3. If the agent rewrote the test text, was that appropriate given the translation system's capabilities?
4. If the agent added a variable AND a rule, evaluate whether the pair is sound — don't penalize the variable addition just because it's incomplete without the rule.

Respond with a single JSON object:

\`\`\`json
{
  "generalizability": "generalizable" | "likely_overfitting" | "unclear",
  "paraphraseRobustness": "robust" | "fragile" | "unknown",
  "rootCauseAddressed": true | false,
  "reasoning": "<2-4 sentences explaining your assessment of the change group as a whole>"
}
\`\`\`

Definitions:
- **generalizability**: "generalizable" if the combined changes address the underlying policy logic and would work for any input testing the same concept. "likely_overfitting" if the changes are narrowly tailored to pass only this specific test text. "unclear" if you can't determine.
- **paraphraseRobustness**: "robust" if paraphrased inputs would be handled correctly by the combined changes. "fragile" if minor rephrasing could cause failures. "unknown" if you can't determine.
- **rootCauseAddressed**: true if the changes fix the actual policy deficiency (wrong logic, missing concept, translation gap, etc.), false if they're a workaround.

Respond with ONLY the JSON object, no other text.`;
}
