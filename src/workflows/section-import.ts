/**
 * Section import workflow — progressive document import.
 *
 * Moved from services/section-import-service.ts per architecture guidelines:
 * importSection and importMultipleSections are multi-step orchestrations
 * across services and UI — that's a workflow, not a service.
 */
import type { ChatService } from '../services/chat-service';
import type { PolicyService } from '../services/policy-service';
import { PollTimeoutError, SECTION_IMPORT_POLL_INTERVAL_MS, SECTION_IMPORT_MAX_POLL_ATTEMPTS } from '../services/policy-service';
import { buildAssetsStore } from '../services/build-assets-store';
import { buildPolicyContext, getKnownEntities } from '../state/policy-state';
import { buildSystemPrompt } from '../prompts/agent-system-prompt';
import { streamAgentMessage } from '../utils/agent-stream';
import type { DocumentSection, PolicyLocalState, TestCaseWithResult, SectionImportState } from '../types';
import type { AutomatedReasoningPolicyDefinition } from '@aws-sdk/client-bedrock';

import type { PolicyStateAccessor } from '../state/policy-state';

/**
 * Callback interface for the section import dialog.
 * Decouples the workflow from the concrete SectionImportDialog component.
 */
export interface SectionImportDialogHandle {
  onSuggestInstructions: ((callback: (instructions: string) => void) => void) | null;
  onConfirm: ((instructions: string) => void) | null;
  show: (sectionTitle: string) => void;
}

/**
 * Dependencies for section import workflows.
 * Uses callback interfaces for UI interaction — no component imports.
 */
export interface SectionImportDeps extends Pick<PolicyStateAccessor,
  | 'getPolicy' | 'getLocalState' | 'getDefinition' | 'setDefinition'
  | 'getBuildWorkflowId' | 'setBuildWorkflowId'
  | 'getSourceDocumentText' | 'getTestsWithResults'
  | 'updateSectionImportState' | 'persistLocalState'
> {
  policyService: PolicyService;
  policyChatService: ChatService;
  // UI callbacks
  chatPanelAppendStatus: (text: string) => HTMLElement;
  chatPanelStartStreaming: () => HTMLElement;
  chatPanelPushStreamChunk: (text: string) => void;
  chatPanelEndStreaming: () => void;
  chatPanelAbortStreaming: (anchor: HTMLElement) => void;
  chatPanelUpdateKnownEntities: (ruleIds: string[], variableNames: string[]) => void;
  docPreviewUpdateSectionState: (sectionId: string, state: SectionImportState) => void;
  // Dialog factory
  createImportDialog: () => SectionImportDialogHandle;
  // Orchestration hooks
  configureMcpTools: (service: ChatService) => Promise<void>;
  loadBuildAssets: (policyArn: string, buildWorkflowId: string) => Promise<void>;
  pollBackgroundWorkflows: (policyArn: string, skipBuildTypes?: ReadonlySet<string>) => Promise<void>;
}

/**
 * Suggest instructions for a section import via the chat agent.
 * Used by the dialog's "Suggest" button.
 */
async function suggestInstructions(
  contentPreview: string,
  deps: SectionImportDeps,
): Promise<string> {
  if (!deps.policyChatService.isConnected) {
    await deps.configureMcpTools(deps.policyChatService);
    await deps.policyChatService.connect(buildSystemPrompt());
  }
  const prompt = [
    'You are helping a user write effective instructions for an Automated Reasoning policy.',
    'Based on the document section below, suggest a concise set of instructions that:',
    '1. Describes the use case — what this section of the policy will validate',
    '2. Describes the types of questions users will ask, with examples',
    '3. Focuses the extraction — which topics in this section to prioritize',
    '', 'Return ONLY the instructions text (no JSON, no markdown fences, no explanation).',
    'Keep it to one short paragraph (3-5 sentences).', '',
    'Document section:', contentPreview,
  ].join('\n');

  let assembled = '';
  const prevHandler = deps.policyChatService.onUpdate;
  deps.policyChatService.onUpdate = (update) => {
    if (update.sessionUpdate === 'agent_message_chunk') {
      if (update.content?.text) assembled += update.content.text;
    }
    prevHandler?.(update);
  };
  try { await deps.policyChatService.sendPolicyMessage(prompt); }
  finally { deps.policyChatService.onUpdate = prevHandler; }
  return assembled.replace(/```[\s\S]*?```/g, '').trim();
}

/**
 * Core import pipeline shared by importSection and importMultipleSections.
 * Runs the full build → test → fidelity → greeting flow.
 */
async function executeSectionImport(
  title: string,
  content: string,
  sections: DocumentSection[],
  instructions: string,
  deps: SectionImportDeps,
): Promise<void> {
  const policy = deps.getPolicy();
  const localState = deps.getLocalState();
  if (!policy || !localState) return;
  const policyArn = policy.policyArn;

  const statusEl = deps.chatPanelAppendStatus(`Importing section: ${title}…`);

  try {
    // 1. Mark all sections in-progress
    for (const section of sections) {
      await deps.updateSectionImportState(section.id, { status: 'in_progress', instructions });
      deps.docPreviewUpdateSectionState(section.id, localState.sectionImports[section.id]);
    }

    // 2. Export the current DRAFT definition so the build merges new content
    //    into the existing policy rather than replacing it.
    let policyDefinition: AutomatedReasoningPolicyDefinition;
    try {
      policyDefinition = await deps.policyService.exportPolicyDefinition(policyArn);
    } catch {
      // First import on a brand-new policy — no definition exists yet
      policyDefinition = { version: '1.0', types: [], rules: [], variables: [] };
    }
    deps.setDefinition(policyDefinition);

    // 3. Ensure build slot
    statusEl.textContent = 'Preparing build slot…';
    await deps.policyService.manageBuildSlot(policyArn, "INGEST_CONTENT");

    // 4. Start INGEST_CONTENT build
    statusEl.textContent = 'Starting build…';
    const docBytes = new TextEncoder().encode(content);
    const description = instructions || `Import of section: ${title}`;
    const buildId = await deps.policyService.startBuild(policyArn, 'INGEST_CONTENT', {
      policyDefinition,
      workflowContent: {
        documents: [{ document: docBytes, documentContentType: 'txt' as const, documentName: title, documentDescription: description }],
      },
    });
    for (const section of sections) {
      await deps.updateSectionImportState(section.id, { status: 'in_progress', buildWorkflowId: buildId });
    }
    console.log('[executeSectionImport] Build started:', buildId);

    // 5. Poll until complete (1-hour timeout: 3s interval × 1200 attempts)
    statusEl.textContent = 'Building policy — this may take a few minutes…';
    const finalBuild = await deps.policyService.pollBuild(policyArn, buildId, SECTION_IMPORT_POLL_INTERVAL_MS, SECTION_IMPORT_MAX_POLL_ATTEMPTS);
    if (finalBuild.status !== 'COMPLETED') throw new Error(`Build ended with status: ${finalBuild.status}`);
    console.log('[executeSectionImport] Build complete:', buildId);

    // 6. Load build assets
    statusEl.textContent = 'Loading build results…';
    await deps.loadBuildAssets(policyArn, buildId);
    deps.setBuildWorkflowId(buildId);

    const storedAssets = buildAssetsStore.get();
    if (storedAssets?.rawPolicyDefinition && 'policyDefinition' in storedAssets.rawPolicyDefinition) {
      deps.setDefinition(storedAssets.rawPolicyDefinition.policyDefinition ?? null);
    }

    // 7. Update DRAFT policy
    statusEl.textContent = 'Saving policy definition…';
    const currentDef = deps.getDefinition();
    if (currentDef) await deps.policyService.updatePolicy(policyArn, currentDef);

    // 7b. Re-export definition to confirm the update, then clean up old builds
    try {
      const confirmedDef = await deps.policyService.exportPolicyDefinition(policyArn);
      deps.setDefinition(confirmedDef);
    } catch (err) {
      console.warn('[executeSectionImport] Post-update export failed (non-critical):', (err as Error).message);
    }
    try {
      await deps.policyService.manageBuildSlot(policyArn, "INGEST_CONTENT", buildId);
    } catch (err) {
      console.warn('[executeSectionImport] Old build cleanup failed (non-critical):', (err as Error).message);
    }

    // 8. Create generated test cases
    statusEl.textContent = 'Creating generated tests…';
    try {
      const testAsset = await deps.policyService.getBuildAssets(policyArn, buildId, 'GENERATED_TEST_CASES');
      const generatedTests = (testAsset && 'generatedTestCases' in testAsset)
        ? testAsset.generatedTestCases?.generatedTestCases ?? []
        : [];
      let created = 0;
      for (const tc of generatedTests) {
        if (!tc.guardContent || !tc.queryContent || !tc.expectedAggregatedFindingsResult) continue;
        try { await deps.policyService.createTestCase(policyArn, tc.guardContent, tc.queryContent, tc.expectedAggregatedFindingsResult); created++; }
        catch (err) { console.warn('[executeSectionImport] Failed to create test case:', (err as Error).message); }
      }
      console.log('[executeSectionImport] Created', created, 'test cases');
    } catch (err) { console.warn('[executeSectionImport] Failed to fetch generated test cases:', (err as Error).message); }

    // 9. Run tests
    statusEl.textContent = 'Running tests…';
    try { await deps.policyService.runTests(policyArn, buildId); await deps.policyService.pollTestCompletion(policyArn, buildId); }
    catch (err) { console.warn('[executeSectionImport] Test execution failed (non-critical):', (err as Error).message); }

    // 10. Mark all sections completed and persist
    for (const section of sections) {
      await deps.updateSectionImportState(section.id, { status: 'completed', buildWorkflowId: buildId });
      deps.docPreviewUpdateSectionState(section.id, localState.sectionImports[section.id]);
    }
    localState.latestBuildWorkflowId = buildId;

    if (storedAssets?.fidelityReport) {
      localState.fidelityReports[buildId] = storedAssets.fidelityReport;
      try { await window.architect.saveFidelityReport(policyArn, buildId, JSON.stringify(storedAssets.fidelityReport)); } catch { /* Fidelity report disk persistence is best-effort; failure does not block the import workflow */ }
    }
    await deps.persistLocalState();

    // 11. Update chat panel entities
    const { ruleIds, variableNames } = getKnownEntities();
    deps.chatPanelUpdateKnownEntities(ruleIds, variableNames);

    // 12. Connect agent and send greeting
    const sectionNames = sections.map((s) => `"${s.title}"`).join(', ');
    statusEl.textContent = sections.length === 1
      ? `Section "${sections[0].title}" imported successfully.`
      : `Imported ${sections.length} sections successfully.`;

    const completedSections = Object.values(localState.sectionImports).filter((s) => s.status === 'completed');
    const isFirstImport = completedSections.length === sections.length;

    if (!deps.policyChatService.isConnected) {
      try { await deps.configureMcpTools(deps.policyChatService); await deps.policyChatService.connect(buildSystemPrompt()); }
      catch (err) { console.warn('[executeSectionImport] Agent connection failed:', (err as Error).message); }
    }

    if (deps.policyChatService.isConnected && deps.getDefinition()) {
      const policyContext = buildPolicyContext();

      let greetingPrompt: string;
      if (isFirstImport) {
        greetingPrompt =
          'The user just imported the first section of their document into this policy. ' +
          'Give a high-level description of what the policy covers so far in at most two short paragraphs. ' +
          'Then summarize the issues from the quality report (if any). Also mention the generated test cases. ' +
          'Finally, suggest a single next action the user should take ' +
          '(e.g., reviewing extracted rules, running tests, importing the next section, or fixing quality issues). ' +
          'Remember to emit the appropriate card (rule, next-steps, follow-up-prompt, etc.) following the Chat Cards Protocol in your instructions.';
      } else if (sections.length === 1) {
        greetingPrompt =
          `The user just imported another section ("${sections[0].title}") into the policy. ` +
          'Focus on what changed: describe the new rules and variables that were added from this section. ' +
          'Highlight any new quality issues introduced by this import. Mention any new test cases that were generated. ' +
          'Suggest a next action — reviewing the new rules, running the new tests, importing another section, or fixing issues. ' +
          'Remember to emit the appropriate card (rule, next-steps, follow-up-prompt, etc.) following the Chat Cards Protocol in your instructions.';
      } else {
        greetingPrompt =
          `The user just imported ${sections.length} sections (${sectionNames}) into the policy in a single batch. ` +
          'Give a high-level summary of what the policy now covers. ' +
          'Highlight any quality issues and mention the generated test cases. ' +
          'Suggest a next action the user should take. ' +
          'Remember to emit the appropriate card (rule, next-steps, follow-up-prompt, etc.) following the Chat Cards Protocol in your instructions.';
      }

      const streamAnchor = deps.chatPanelStartStreaming();

      streamAgentMessage(
        deps.policyChatService,
        { pushStreamChunk: (text) => deps.chatPanelPushStreamChunk(text) },
        greetingPrompt,
        policyContext,
        { logPrefix: 'executeSectionImport' },
      ).then(() => { deps.chatPanelEndStreaming(); })
        .catch((err) => { deps.chatPanelAbortStreaming(streamAnchor); console.warn('[executeSectionImport] Agent greeting failed:', (err as Error).message); });
    }

    // 13. Poll remaining background workflows
    deps.pollBackgroundWorkflows(policyArn).catch((err) => { console.warn('[executeSectionImport] Background polling failed:', (err as Error).message); });

  } catch (err) {
    console.error('[executeSectionImport] Failed:', (err as Error).message);
    const isTimeout = err instanceof PollTimeoutError;
    for (const section of sections) {
      const state = localState.sectionImports[section.id];
      if (state?.status === 'in_progress') {
        await deps.updateSectionImportState(section.id, { status: isTimeout ? 'timed_out' : 'failed' });
        deps.docPreviewUpdateSectionState(section.id, localState.sectionImports[section.id]);
      }
    }
    if (isTimeout) {
      statusEl.textContent = 'Import is still running — it will be checked on next launch.';
      deps.chatPanelAppendStatus(`Import for "${title}" is taking longer than expected. The build will be checked automatically next time you open this policy.`);
    } else {
      statusEl.textContent = `Import failed: ${(err as Error).message}`;
      deps.chatPanelAppendStatus(`Failed to import section "${title}": ${(err as Error).message}`);
    }
  }
}

/**
 * Show the import dialog and run the import pipeline for the given sections.
 * Used by both importSection (single) and importMultipleSections (batch).
 */
function showDialogAndImport(
  dialogTitle: string,
  contentForSuggestion: string,
  buildTitle: string,
  buildContent: string,
  sections: DocumentSection[],
  deps: SectionImportDeps,
): void {
  const policy = deps.getPolicy();
  const localState = deps.getLocalState();
  if (!policy || !localState || sections.length === 0) return;

  const dialog = deps.createImportDialog();

  dialog.onSuggestInstructions = (callback) => {
    suggestInstructions(contentForSuggestion, deps)
      .then((suggestion) => callback(suggestion))
      .catch((err) => {
        console.warn('[showDialogAndImport] Suggest instructions failed:', (err as Error).message);
        callback('(Could not generate suggestions. Please write instructions manually.)');
      });
  };

  dialog.onConfirm = (instructions: string) => {
    executeSectionImport(buildTitle, buildContent, sections, instructions, deps);
  };

  dialog.show(dialogTitle);
}

/**
 * Import a single document section into the policy via INGEST_CONTENT.
 * Shows a dialog for instructions, then runs the full build → test → fidelity pipeline.
 */
export function importSection(
  section: DocumentSection,
  deps: SectionImportDeps,
): void {
  showDialogAndImport(
    section.title,
    section.content.slice(0, 15000),
    section.title,
    section.content,
    [section],
    deps,
  );
}

/**
 * Import multiple document sections in a single INGEST_CONTENT build.
 * All sections are merged into one document so the system can reason
 * about the combined schema holistically rather than merging incrementally.
 */
export function importMultipleSections(
  sections: DocumentSection[],
  deps: SectionImportDeps,
): void {
  if (sections.length === 0) return;

  const localState = deps.getLocalState();
  const docPath = localState?.documentPath ?? '';
  const baseName = docPath.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') || 'document';

  const allSectionIds = new Set((localState?.sections ?? []).map((s) => s.id));
  const isAllSections =
    sections.length === allSectionIds.size &&
    sections.every((s) => allSectionIds.has(s.id));
  let mergedTitle: string;

  if (isAllSections) {
    // All sections selected — just use the source file name
    mergedTitle = baseName;
  } else {
    const sectionNumbers = sections
      .map((s, i) => {
        // Section IDs are 0-based ("s0-..."), convert to 1-based for display
        const match = s.id.match(/^s(\d+)/);
        return match ? `${Number(match[1]) + 1}` : `${i + 1}`;
      })
      .join(', ');

    const MAX_TITLE_LENGTH = 200;
    const prefix = `${baseName} - sections `;
    const sectionLabel = prefix.length + sectionNumbers.length > MAX_TITLE_LENGTH
      ? `${sections.length} sections`
      : sectionNumbers;
    mergedTitle = `${prefix}${sectionLabel}`;
  }

  const mergedContent = sections.map((s) => s.content).join('\n\n');

  showDialogAndImport(
    mergedTitle,
    mergedContent.slice(0, 15000),
    mergedTitle,
    mergedContent,
    sections,
    deps,
  );
}
