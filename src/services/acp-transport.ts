/**
 * Transport abstraction for ACP (Agent Client Protocol) communication.
 *
 * This decouples ChatService from the Electron IPC bridge so the ACP
 * connection can be tested without booting the full UI. Two implementations:
 *
 *   - IpcAcpTransport: delegates to window.architect.* (production, renderer process)
 *   - DirectAcpTransport: uses AcpClient directly (testing, Node.js process)
 */

/** Callback for streamed session updates from the ACP agent. */
export type AcpUpdateCallback = (update: unknown) => void;

/** Configuration for an MCP server to register with an ACP session. */
export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Minimal surface for ACP lifecycle operations.
 * ChatService programs against this interface instead of window.architect directly.
 */
export interface AcpTransport {
  start(cwd?: string): Promise<void>;
  createSession(cwd?: string, systemPrompt?: string, mcpServers?: McpServerConfig[]): Promise<string>;
  sendPrompt(text: string, sessionId?: string): Promise<{ stopReason: string }>;
  cancel(sessionId?: string): void;
  stop(): void;
  onUpdate(callback: AcpUpdateCallback): (() => void) | void;
}

/**
 * Production transport — delegates to the Electron preload bridge.
 * This is a thin wrapper that preserves the existing behavior exactly.
 */
export class IpcAcpTransport implements AcpTransport {
  start(cwd?: string): Promise<void> {
    return window.architect.acpStart(cwd);
  }
  createSession(cwd?: string, systemPrompt?: string, mcpServers?: McpServerConfig[]): Promise<string> {
    return window.architect.acpCreateSession(cwd, systemPrompt, mcpServers);
  }
  sendPrompt(text: string, sessionId?: string): Promise<{ stopReason: string }> {
    return window.architect.acpSendPrompt(text, sessionId);
  }
  cancel(sessionId?: string): void {
    window.architect.acpCancel(sessionId);
  }
  stop(): void {
    window.architect.acpStop();
  }
  onUpdate(callback: AcpUpdateCallback): (() => void) | void {
    return window.architect.onAcpUpdate(callback);
  }
}
