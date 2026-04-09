/**
 * Shared ACP agent streaming utility.
 *
 * Encapsulates the save-handler / set-handler / stream / restore-handler
 * pattern that was duplicated across 5+ call sites. Each caller provides
 * UI callbacks through the StreamCallbacks interface so this module
 * never imports components directly.
 */
import type { ChatService } from '../services/chat-service';
import { isToolResultError } from './retry';

/** Parsed tool_call fields forwarded to callbacks. */
export interface ToolCallInfo {
  title: string;
  status: string;
  toolCallId: string;
  input?: unknown;
}

/** Parsed tool_result fields forwarded to callbacks. */
export interface ToolResultInfo {
  toolCallId: string;
  contentStr: string;
  isError: boolean;
}

/** UI callbacks for the streaming pattern. All optional except pushStreamChunk. */
export interface StreamCallbacks {
  /** Push a text chunk into the streaming UI. */
  pushStreamChunk: (text: string) => void;
  /** Called when an agent_message_chunk arrives (after pushStreamChunk). */
  onMessageChunk?: () => void;
  /** Called when a tool_call update arrives. */
  onToolCall?: (info: ToolCallInfo) => void;
  /** Called when a tool_result update arrives. */
  onToolResult?: (info: ToolResultInfo) => void;
  /** Note that a tool call started (e.g. show a spinner). */
  noteToolCallStarted?: () => void;
  /** Signal tool activity with a friendly label for the UI indicator. */
  noteToolActivity?: (label: string) => void;
}

/** Options for streamAgentMessage / installStreamHandler. */
export interface StreamOptions {
  /** Label used in console log prefixes (e.g. 'loadPolicy', 'testSession'). */
  logPrefix?: string;
}

/**
 * Install a streaming update handler on a ChatService.
 *
 * Saves the current `onUpdate`, installs a new one that dispatches
 * by `sessionUpdate` type, and returns a handle with:
 * - `previousHandler` — the saved handler (for in-flight prompt tracking)
 * - `restore()` — restores the previous handler
 *
 * Use this when the caller manages the send lifecycle itself
 * (e.g. in-flight prompt tracking, interruption support).
 * For fire-and-forget streaming, use `streamAgentMessage` instead.
 */
export function installStreamHandler(
  chatService: ChatService,
  callbacks: StreamCallbacks,
  options: StreamOptions = {},
): { previousHandler: ChatService['onUpdate']; restore: () => void } {
  const prefix = options.logPrefix ?? 'agentStream';
  const previousHandler = chatService.onUpdate;

  chatService.onUpdate = (update) => {
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.text) {
      callbacks.pushStreamChunk(update.content.text);
      callbacks.onMessageChunk?.();
    }
    if (update.sessionUpdate === 'tool_call') {
      const info: ToolCallInfo = {
        title: update.title ?? 'unknown',
        status: update.status ?? '',
        toolCallId: update.toolCallId ?? '',
        input: update.input ?? update.arguments,
      };
      console.log("[%s tool_call] %s (%s)", prefix, info.title, info.status);
      callbacks.noteToolCallStarted?.();
      callbacks.noteToolActivity?.(info.title);
      callbacks.onToolCall?.(info);
    }
    if (update.sessionUpdate === 'tool_result') {
      const content = update.content;
      const contentStr = typeof content === 'string'
        ? content
        : content ? JSON.stringify(content) : '';
      const isError = isToolResultError(contentStr);
      if (isError) {
        console.error("[%s tool_result ERROR]", prefix, contentStr.slice(0, 2000));
      }
      callbacks.onToolResult?.({ toolCallId: update.toolCallId ?? '', contentStr, isError });
    }
    previousHandler?.(update);
  };

  return { previousHandler, restore: () => { chatService.onUpdate = previousHandler; } };
}

/**
 * Stream an agent message through a ChatService, forwarding chunks to the UI.
 *
 * Handles the full lifecycle:
 * 1. Installs a streaming handler (via installStreamHandler)
 * 2. Calls `chatService.sendPolicyMessage`
 * 3. Restores the previous handler in `finally`
 *
 * For callers that need to control the send themselves (e.g. in-flight
 * prompt tracking), use `installStreamHandler` directly.
 */
export async function streamAgentMessage(
  chatService: ChatService,
  callbacks: StreamCallbacks,
  prompt: string,
  policyContext?: Record<string, unknown>,
  options: StreamOptions = {},
): Promise<void> {
  const { restore } = installStreamHandler(chatService, callbacks, options);
  try {
    await chatService.sendPolicyMessage(prompt, policyContext);
  } finally {
    restore();
  }
}
