/**
 * Test panel event handlers and orchestration.
 *
 * Pure analysis functions (buildTestAnalysisPrompt, computeTestHighlightFilter)
 * live in src/utils/test-analysis.ts. This file handles only side-effectful
 * orchestration across services, state, and UI components.
 */
import type { TestCaseWithResult } from '../types';
import type { AutomatedReasoningPolicyDefinition, AutomatedReasoningCheckResult } from '@aws-sdk/client-bedrock';
import type { PolicyService } from '../services/policy-service';
import type { ChatSessionManager } from '../services/chat-session-manager';
import type { DocumentPreviewHandle as DocumentPreview } from '../components/DocumentPreviewPanel';
import type { ChatPanelHandle as ChatPanel } from '../components/ChatPanelComponent';
import type { TestPanelHandle as TestPanel } from '../components/TestPanel';
import { ChatService } from '../services/chat-service';
import { withRetry, isThrottlingError } from '../utils/retry';
import { buildTestAnalysisPrompt, computeTestHighlightFilter } from '../utils/test-analysis';

import type { PolicyStateAccessor } from '../state/policy-state';

export interface TestWorkflowDeps extends Pick<PolicyStateAccessor,
  | 'getPolicy' | 'getDefinition'
  | 'getBuildWorkflowId' | 'setBuildWorkflowId'
  | 'getTestsWithResults' | 'setTestsWithResults' | 'setTestCases'
  | 'getSourceDocumentText'
> {
  policyService: PolicyService;
  chatSessionMgr: ChatSessionManager;
  chatPanel: ChatPanel;
  docPreview: DocumentPreview;
  testPanel: TestPanel;
  loadBuildAssets: (policyArn: string, buildWorkflowId: string) => Promise<void>;
  getLocalState?: () => import('../types').PolicyLocalState | null;
  persistLocalState?: () => Promise<void>;
}

/**
 * Apply test highlight filter to the document preview.
 */
export function applyTestHighlightFilter(
  test: TestCaseWithResult,
  definition: AutomatedReasoningPolicyDefinition | null,
  docPreview: DocumentPreview,
): void {
  const filter = computeTestHighlightFilter(test, definition);
  if (filter.hasFilter) {
    const testId = test.testCase.testCaseId ?? '';
    const query = test.testCase.queryContent ?? '';
    const testLabel = query
      ? (query.length > 50 ? query.slice(0, 50) + '…' : query)
      : `Test ${testId.slice(0, 8)}`;
    docPreview.filterByTestFindings(filter.directRuleIds, filter.inferredRuleIds, filter.variables, testLabel);
  } else {
    docPreview.clearFilter();
  }
}

/**
 * Refresh the test panel after a policy change (e.g., REFINE_POLICY build).
 */
export async function refreshTestsAfterPolicyChange(deps: TestWorkflowDeps): Promise<void> {
  const policy = deps.getPolicy();
  if (!policy) return;
  console.log('[refreshTestsAfterPolicyChange] Policy was updated, refreshing tests...');
  deps.testPanel.setLoading(true);
  try {
    const builds = await deps.policyService.listBuilds(policy.policyArn);
    const latestCompleted = deps.policyService.findLatestPolicyBuild(builds);
    if (!latestCompleted) {
      console.log('[refreshTestsAfterPolicyChange] No completed build found, falling back to test cases only');
      const cases = await deps.policyService.listTestCases(policy.policyArn);
      const asResults: TestCaseWithResult[] = cases.map((tc) => ({ testCase: tc }));
      deps.testPanel.loadTests(asResults);
      deps.setTestsWithResults(asResults);
      deps.setTestCases(asResults);
      return;
    }

    const previousBuildId = deps.getBuildWorkflowId();
    deps.setBuildWorkflowId(latestCompleted.buildWorkflowId);

    if (previousBuildId !== latestCompleted.buildWorkflowId) {
      console.log('[refreshTestsAfterPolicyChange] Build changed:', previousBuildId, '→', latestCompleted.buildWorkflowId);
      await deps.loadBuildAssets(policy.policyArn, latestCompleted.buildWorkflowId);

      // Show stale banner if the fidelity report predates this policy build
      const localState = deps.getLocalState?.();
      const fidelityTimestamp = localState?.lastFidelityReportTimestamp;
      const policyBuildIsNewer = !fidelityTimestamp || latestCompleted.updatedAt.getTime() > fidelityTimestamp;
      if (policyBuildIsNewer) {
        console.log('[refreshTestsAfterPolicyChange] Fidelity report is stale — showing banner');
        deps.docPreview.setStaleFidelityBanner(true);
      }
    }

    const results = await deps.policyService.loadTestsWithResults(policy.policyArn, latestCompleted.buildWorkflowId);
    deps.testPanel.loadTests(results);
    deps.setTestsWithResults(results);
    deps.setTestCases(results);

    // Persist the latest build ID to local cache
    const localState = deps.getLocalState?.();
    if (localState) {
      localState.latestBuildWorkflowId = latestCompleted.buildWorkflowId;
      await deps.persistLocalState?.();
    }

    const selectedId = deps.testPanel.getSelectedTestId();
    if (selectedId) {
      const selectedTest = results.find((t) => t.testCase.testCaseId === selectedId);
      if (selectedTest) {
        deps.testPanel.setSelectedTest(selectedId);
        applyTestHighlightFilter(selectedTest, deps.getDefinition(), deps.docPreview);
      }
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (isThrottlingError(err)) {
      console.warn('[refreshTestsAfterPolicyChange] Throttled:', msg);
      deps.chatPanel.appendStatus('Rate limited while refreshing tests. Click the refresh button to try again.');
    } else {
      console.warn('[refreshTestsAfterPolicyChange] Failed:', msg);
    }
  } finally {
    deps.testPanel.setLoading(false);
  }
}

/**
 * Wire all test panel event handlers. Returns a cleanup function (currently no-op).
 */
export function wireTestPanelHandlers(deps: TestWorkflowDeps): void {
  const { policyService, chatSessionMgr, chatPanel, docPreview, testPanel } = deps;

  testPanel.onTestSelect = async (test: TestCaseWithResult) => {
    const testId = test.testCase.testCaseId!;
    const router = chatPanel.getRouter();
    chatSessionMgr.cancelActivePrompt();

    // Save the current test's ChatService to the cache (messages are already in the router)
    if (chatSessionMgr.activeTestId && chatSessionMgr.testChatService) {
      chatSessionMgr.testSessionCache.set(chatSessionMgr.activeTestId, {
        chatService: chatSessionMgr.testChatService,
        messagesHtml: "", // Messages live in the router now, not serialized
      });
    }

    testPanel.setSelectedTest(testId);
    const testLabel = test.testCase.queryContent
      ? (test.testCase.queryContent.length > 50 ? test.testCase.queryContent.slice(0, 50) + '…' : test.testCase.queryContent)
      : `Test ${testId.slice(0, 8)}`;
    chatPanel.setContext(`Test: ${testLabel}`, true);
    applyTestHighlightFilter(test, deps.getDefinition(), docPreview);

    const contextKey = `test-${testId}`;
    // Switch the router to this test's context (lazily creates if new)
    router.setActive(contextKey);

    // Restore cached ChatService if available, otherwise start fresh
    const cached = chatSessionMgr.testSessionCache.get(testId);
    if (cached && router.has(contextKey)) {
      // Context already has messages in the router — just restore the ChatService
      chatSessionMgr.testChatService = cached.chatService;
      chatSessionMgr.activeTestId = testId;
      chatSessionMgr.testSessionCache.delete(testId);
    } else {
      // Clean up stale cache entry if any
      if (cached) {
        cached.chatService.disconnect();
        chatSessionMgr.testSessionCache.delete(testId);
      }
      chatSessionMgr.activeTestId = testId;
      // Create a bound UI for this test context — streams always write here
      const testUI = router.createBoundUI(contextKey);
      await chatSessionMgr.startTestChatSession(test, testUI);
    }

    // Ensure the active test ChatService always carries the test context
    if (chatSessionMgr.testChatService) {
      chatSessionMgr.testChatService.testContext = buildTestAnalysisPrompt(test);
    }
  };

  testPanel.onTestDeselect = () => {
    const router = chatPanel.getRouter();
    chatSessionMgr.cancelActivePrompt();
    if (chatSessionMgr.activeTestId && chatSessionMgr.testChatService) {
      chatSessionMgr.testSessionCache.set(chatSessionMgr.activeTestId, {
        chatService: chatSessionMgr.testChatService,
        messagesHtml: "",
      });
    }
    chatSessionMgr.testChatService = null;
    chatSessionMgr.activeTestId = null;
    docPreview.clearFilter();

    const policyName = deps.getPolicy()?.name ?? 'Policy Chat';
    // Switch back to the policy context — its messages are already there
    router.setActive("policy");
    chatPanel.setContext(policyName);
  };

  chatPanel.onBackToPolicy = () => {
    // Delegate to deselectTest which triggers onTestDeselect —
    // that handler saves the test session and switches to policy context.
    testPanel.deselectTest();
  };

  testPanel.onRefreshTests = async () => {
    const policy = deps.getPolicy();
    if (!policy) return;
    testPanel.setLoading(true);
    try {
      await withRetry(async () => {
        const builds = await policyService.listBuilds(policy.policyArn);
        const latestCompleted = policyService.findLatestPolicyBuild(builds);
        if (!latestCompleted) {
          console.log('[onRefreshTests] No completed build found, falling back to test cases only');
          const cases = await policyService.listTestCases(policy.policyArn);
          const asResults: TestCaseWithResult[] = cases.map((tc) => ({ testCase: tc }));
          testPanel.loadTests(asResults);
          deps.setTestsWithResults(asResults);
          deps.setTestCases(asResults);
          return;
        }
        deps.setBuildWorkflowId(latestCompleted.buildWorkflowId);
        const results = await policyService.loadTestsWithResults(policy.policyArn, latestCompleted.buildWorkflowId);
        testPanel.loadTests(results);
        deps.setTestsWithResults(results);
        deps.setTestCases(results);

        // Persist the latest build ID to local cache
        const localState = deps.getLocalState?.();
        if (localState) {
          localState.latestBuildWorkflowId = latestCompleted.buildWorkflowId;
          await deps.persistLocalState?.();
        }
      }, {
        onRetry: (attempt, delay) => {
          testPanel.setLoading(true, `Rate limited — retrying in ${Math.round(delay / 1000)}s (attempt ${attempt})…`);
        },
      });
    } catch (err) {
      if (isThrottlingError(err)) {
        testPanel.setLoading(false, 'Rate limited — please wait a moment and try again.');
        chatPanel.appendStatus('Too many requests. Please wait a moment before refreshing tests.');
      } else { console.error('[onRefreshTests] Failed:', (err as Error).message); }
    } finally { testPanel.setLoading(false); }
  };

  testPanel.onCreateTest = async (question: string, answer: string) => {
    const policy = deps.getPolicy();
    const buildId = deps.getBuildWorkflowId();
    if (!policy || !buildId) return;
    try {
      await createAndRefreshTest(policy.policyArn, buildId, answer, question, 'SATISFIABLE', deps);
    } catch (err) {
      console.error('[onCreateTest] Failed:', (err as Error).message);
      chatPanel.appendStatus('Failed to create test. Check the console for details.');
    }
  };

  testPanel.onSuggestTest = async () => {
    const policy = deps.getPolicy();
    const definition = deps.getDefinition();
    if (!policy || !definition) return;
    testPanel.setSuggestLoading(true);
    try {
      const existingTests = deps.getTestsWithResults().map((t) => ({
        question: t.testCase.queryContent, answer: t.testCase.guardContent,
      }));
      const suggestPrompt = [
        'Suggest a single new test case (question and answer) for this policy.',
        'The test should cover an area of the source document that is NOT already covered by existing tests.',
        '', `Policy definition: ${JSON.stringify(definition)}`, '',
        existingTests.length > 0 ? `Existing tests:\n${JSON.stringify(existingTests, null, 2)}` : 'There are no existing tests yet.',
        '', 'Respond with ONLY a JSON object in this exact format, no other text:', '{"question": "...", "answer": "..."}',
      ].join('\n');

      const suggestService = new ChatService();
      await suggestService.connect(
        'You are a helpful assistant that suggests test cases for Automated Reasoning policies. ' +
        'You respond with ONLY a JSON object containing question and answer fields. No markdown, no explanation.'
      );
      const suggestResponse = await suggestService.sendRawMessage(suggestPrompt);
      const responseText = suggestResponse.content;
      suggestService.disconnect();

      const jsonMatch = responseText.match(/\{[\s\S]*"question"[\s\S]*"answer"[\s\S]*\}/);
      if (jsonMatch) {
        const suggestion = JSON.parse(jsonMatch[0]) as { question: string; answer: string };
        testPanel.populateForm(suggestion.question, suggestion.answer);
      } else {
        console.warn('[onSuggestTest] Could not parse suggestion:', responseText);
        chatPanel.appendStatus('Could not parse the suggested test. Try again or write one manually.');
        window.architect.logRendererEvent('test-parse-failure', {
          source: 'onSuggestTest',
          promptText: suggestPrompt.slice(0, 2000),
          responseText: responseText.slice(0, 2000),
        });
      }
    } catch (err) {
      console.error('[onSuggestTest] Failed:', (err as Error).message);
      chatPanel.appendStatus('Failed to suggest a test. Try again.');
    } finally { testPanel.setSuggestLoading(false); }
  };

  docPreview.onGenerateTestFromSelection = async (selectedText: string) => {
    const policy = deps.getPolicy();
    const definition = deps.getDefinition();
    if (!policy || !definition) return;

    testPanel.setGenerateFromSelectionLoading(true);
    try {
      // Gather up to 5 passing tests as examples
      const passingTests = deps.getTestsWithResults()
        .filter((t) => t.aggregatedTestFindingsResult === 'SATISFIABLE')
        .slice(0, 5)
        .map((t) => ({ question: t.testCase.queryContent, answer: t.testCase.guardContent }));

      const sourceDoc = deps.getSourceDocumentText() ?? '';

      const generatePrompt = [
        'Generate a single test case (question and answer) about the following highlighted passage from the source document.',
        'The test should verify that the policy correctly handles the concepts described in the highlighted text.',
        '',
        '## Highlighted text',
        selectedText,
        '',
        sourceDoc ? `## Source document (for context)\n${sourceDoc.slice(0, 4000)}` : '',
        '',
        `## Policy definition\n${JSON.stringify(definition)}`,
        '',
        passingTests.length > 0
          ? `## Example passing tests (use similar style)\n${JSON.stringify(passingTests, null, 2)}`
          : 'There are no existing tests yet. Create a natural-sounding question and answer.',
        '',
        'Respond with ONLY a JSON object in this exact format, no other text:',
        '{"question": "...", "answer": "..."}',
      ].join('\n');

      const genService = new ChatService();
      await genService.connect(
        'You are a helpful assistant that generates test cases for Automated Reasoning policies based on highlighted source document text. ' +
        'You respond with ONLY a JSON object containing question and answer fields. No markdown, no explanation.'
      );
      const genResponse = await genService.sendRawMessage(generatePrompt);
      const responseText = genResponse.content;
      genService.disconnect();

      const jsonMatch = responseText.match(/\{[\s\S]*"question"[\s\S]*"answer"[\s\S]*\}/);
      if (jsonMatch) {
        const suggestion = JSON.parse(jsonMatch[0]) as { question: string; answer: string };
        testPanel.populateForm(suggestion.question, suggestion.answer);
      } else {
        console.warn('[onGenerateTestFromSelection] Could not parse suggestion:', responseText);
        chatPanel.appendStatus('Could not parse the generated test. Try writing one manually.');
        window.architect.logRendererEvent('test-parse-failure', {
          source: 'onGenerateTestFromSelection',
          promptText: generatePrompt.slice(0, 2000),
          responseText: responseText.slice(0, 2000),
        });
      }
    } catch (err) {
      console.error('[onGenerateTestFromSelection] Failed:', (err as Error).message);
      chatPanel.appendStatus('Failed to generate test from selection. Try again.');
    } finally {
      testPanel.setGenerateFromSelectionLoading(false);
    }
  };
}
/**
 * Create a test case and refresh the test panel with updated results.
 * Shared by onCreateTest and onGenerateTestFromSelection to avoid duplication.
 */
async function createAndRefreshTest(
  policyArn: string,
  buildId: string,
  answer: string,
  question: string,
  expectedResult: AutomatedReasoningCheckResult,
  deps: Pick<TestWorkflowDeps, 'policyService' | 'testPanel' | 'setTestsWithResults' | 'setTestCases'>,
): Promise<void> {
  const { policyService, testPanel } = deps;
  const testCaseId = await policyService.createTestCase(policyArn, answer, question, expectedResult);
  const results = await policyService.loadTestsWithResults(policyArn, buildId);
  testPanel.loadTests(results);
  deps.setTestsWithResults(results);
  deps.setTestCases(results);
  testPanel.hideCreateForm();
  const newTest = results.find((t) => t.testCase.testCaseId === testCaseId);
  if (newTest) testPanel.onTestSelect?.(newTest);
}


