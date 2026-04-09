/**
 * No-op stub factories for panel handles.
 *
 * Used as a safety net when initializeWorkspaceUI runs before React
 * components have mounted and provided their imperative handles.
 * Also importable by tests that need lightweight panel stubs.
 */
import type { ChatPanelHandle } from "../components/ChatPanelComponent";
import type { DocumentPreviewHandle } from "../components/DocumentPreviewPanel";
import type { TestPanelHandle } from "../components/TestPanel";

/**
 * Create a minimal ChatPanelHandle stub.
 * `appendStatus` and `updateStatus` create real DOM elements so that
 * status-tracking logic (which inspects `.textContent`) still works.
 */
export function createChatPanelStub(container?: HTMLElement): ChatPanelHandle {
  const stubContainer = container ?? document.getElementById("chat-messages") ?? document.createElement("div");
  return {
    appendStatus: (text: string) => {
      const div = document.createElement("div");
      div.className = "chat-msg assistant status-bubble";
      const step = document.createElement("div");
      step.className = "status-current-step";
      step.textContent = text;
      div.appendChild(step);
      stubContainer.appendChild(div);
      return div;
    },
    updateStatus: (el: HTMLElement, text: string, isError = false) => {
      const step = el.querySelector(".status-current-step");
      if (step) {
        const prev = step.textContent;
        if (prev && prev !== text) {
          const log = document.createElement("div");
          log.className = "status-log-entry";
          log.textContent = `✓ ${prev.replace(/…$/, "")}`;
          el.insertBefore(log, step);
        }
        step.textContent = text;
        step.classList.toggle("status-step-error", isError);
      }
    },
    appendMessage: () => {},
    startStreaming: () => document.createElement("div"),
    pushStreamChunk: () => {},
    endStreaming: () => {},
    abortStreaming: () => {},
    noteToolCallStarted: () => {},
    noteToolActivity: () => {},
    setContext: () => {},
    clearMessages: () => {},
    saveMessages: () => "",
    restoreMessages: () => {},
    restoreMessagesWithCardActions: () => {},
    restoreFilteredWithCardActions: () => "",
    restoreMessagesStrippingStaleCards: () => "",
    prefillInput: () => {},
    updateKnownEntities: () => {},
    linkifyEntities: () => {},
    showEmptyImportState: () => {},
  } as unknown as ChatPanelHandle;
}

/** Create a minimal DocumentPreviewHandle stub. All methods are no-ops. */
export function createDocPreviewStub(): DocumentPreviewHandle {
  return {
    loadDocument: () => {},
    loadSections: () => {},
    updateSectionState: () => {},
    setHighlightsFromFidelityReport: () => {},
    setHighlightsFromSummary: () => {},
    setLoading: () => {},
    setRegenerateButtonVisible: () => {},
    setStaleFidelityBanner: () => {},
    filterByEntity: () => {},
    filterByRuleIds: () => {},
    filterByVariableNames: () => {},
    filterByTestFindings: () => {},
    clearFilter: () => {},
    emphasize: () => {},
    emphasizeVariable: () => {},
    showOpenPrompt: () => {},
    exitAccordionMode: () => {},
    getRawText: () => "",
    hasDocument: false,
  } as unknown as DocumentPreviewHandle;
}

/** Create a minimal TestPanelHandle stub. All methods are no-ops. */
export function createTestPanelStub(): TestPanelHandle {
  return {
    loadTests: () => {},
    setSelectedTest: () => {},
    getSelectedTestId: () => null,
    updateTestResult: () => {},
    setLoading: () => {},
    showCreateForm: () => {},
    hideCreateForm: () => {},
    populateForm: () => {},
    setSuggestLoading: () => {},
    setGenerateFromSelectionLoading: () => {},
    deselectTest: () => {},
    showEmptyImportState: () => {},
  };
}
