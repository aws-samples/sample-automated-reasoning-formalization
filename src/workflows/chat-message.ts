/**
 * Chat message workflow — handles sending messages through the agent.
 *
 * Extracted from renderer.ts per architecture guidelines:
 * the onSendMessage handler is ~140 lines of inline orchestration
 * (connection management, streaming, update handler chaining,
 * policy context construction, policy-update detection, error handling).
 * The composition root should be thin and delegate reusable logic.
 */
import type { ChatService } from '../services/chat-service';
import type { ChatSessionManager } from '../services/chat-session-manager';
import { buildSystemPrompt } from '../prompts/agent-system-prompt';
import { buildTestSystemPrompt } from '../prompts/test-system-prompt';
import { installStreamHandler } from '../utils/agent-stream';
import { mapToolToActivityLabel } from '../utils/tool-labels';
import * as State from '../state/policy-state';
import { serializeContextIndex } from '../services/context-index';

/** Dependencies injected from the composition root. */
export interface ChatMessageDeps {
  chatSessionMgr: ChatSessionManager;
  // State accessors
  getTestChatService: () => ChatService | null;
  getSelectedTest: () => import('../types').TestCaseWithResult | undefined;
  // Post-turn callback
  refreshTestsAfterPolicyChange: () => void;
  // Context index file persistence (for MCP subprocess)
  writeContextIndexFile: (json: string) => Promise<void>;
}

/**
 * Creates the onSendMessage handler wired to the chat panel.
 * Returns an async function matching the ChatPanel.onSendMessage signature.
 */
export function createSendMessageHandler(deps: ChatMessageDeps): (message: string) => Promise<void> {
  const {
    chatSessionMgr,
    getTestChatService,
    getSelectedTest,
    refreshTestsAfterPolicyChange,
    writeContextIndexFile,
  } = deps;

  return async (message: string) => {
    const chatService = chatSessionMgr.activeChatService();
    // Resolve the correct bound UI for the current context at send time
    const ui = chatSessionMgr.activeUI();

    // Interrupt in-flight prompt if the user sends a follow-up
    chatSessionMgr.cancelActivePrompt();

    // Ensure the chat service is connected (lazy-connect on first message)
    if (!chatService.isConnected) {
      const connectingEl = ui.appendStatus('Connecting to agent...');
      try {
        const prompt = getTestChatService() ? buildTestSystemPrompt() : buildSystemPrompt();
        await chatSessionMgr.configureMcpTools(chatService);
        await chatService.connect(prompt);
        connectingEl.remove();
      } catch (err) {
        connectingEl.textContent = `Failed to connect: ${(err as Error).message}`;
        return;
      }
    }

    // Use a detached element as an identity token for in-flight prompt tracking.
    // The streaming indicator (startStreaming) already shows a visual "thinking" state,
    // so we no longer append a separate status segment to avoid duplicate indicators.
    const statusEl = document.createElement('div');
    const streamAnchor = ui.startStreaming();

    // Track whether the agent updated the policy so we can auto-refresh tests
    let policyWasUpdated = false;

    const { previousHandler, restore } = installStreamHandler(chatService, {
      pushStreamChunk: (text) => ui.pushStreamChunk(text),
      noteToolCallStarted: () => ui.noteToolCallStarted(),
      noteToolActivity: (title) => ui.noteToolActivity(mapToolToActivityLabel(title)),
      onToolCall: (info) => {
        console.log(
          "[tool_call] %s (%s) id=%s",
          info.title, info.status, info.toolCallId,
          info.input ? { input: info.input } : '',
        );
        if (info.title.toLowerCase().includes('update-automated-reasoning-policy')
          && !info.title.toLowerCase().includes('test')) {
          policyWasUpdated = true;
        }
      },
      onToolResult: (info) => {
        if (info.isError) {
          console.error("[tool_result ERROR] id=%s", info.toolCallId, info.contentStr.slice(0, 500));
        } else {
          console.log("[tool_result] id=%s", info.toolCallId, info.contentStr.slice(0, 500));
        }
      },
    }, { logPrefix: 'chat' });

    // Register this prompt as in-flight so it can be interrupted
    chatSessionMgr.inFlightPrompt = { chatService, targetUI: ui, statusEl, streamAnchor, previousHandler };

    try {
      const policyContext = State.buildPolicyContext(getSelectedTest());
      await chatService.sendPolicyMessage(message, policyContext);
      // Only clean up if this prompt wasn't interrupted (inFlightPrompt still points to us)
      if (chatSessionMgr.inFlightPrompt?.statusEl === statusEl) {
        chatSessionMgr.inFlightPrompt = null;
      }
      ui.endStreaming();
    } catch (err) {
      // If this prompt was interrupted by a follow-up, don't show an error —
      // the interruption handler already cleaned up the UI.
      if (chatSessionMgr.inFlightPrompt?.statusEl === statusEl) {
        chatSessionMgr.inFlightPrompt = null;
        ui.abortStreaming(streamAnchor);
      }
    } finally {
      restore();

      // Auto-refresh test panel after a policy update (REFINE_POLICY completion)
      if (policyWasUpdated && State.getPolicy()) {
        // Rebuild the context index with the updated definition
        State.rebuildContextIndex();
        const index = State.getContextIndex();
        if (index) {
          try {
            const json = JSON.stringify(serializeContextIndex(index));
            await writeContextIndexFile(json);
          } catch (err) {
            console.warn('[chat-message] Failed to write context index file:', (err as Error).message);
          }
        }
        refreshTestsAfterPolicyChange();
      }
    }
  };
}
