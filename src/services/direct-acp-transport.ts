/**
 * Direct ACP transport — uses AcpClient without Electron IPC.
 *
 * This lets integration tests (and CLI tools) exercise the full
 * AcpClient → kiro-cli connection in a plain Node.js process.
 */
import { AcpClient } from "./acp-client";
import type { AcpTransport, AcpUpdateCallback, McpServerConfig } from "./acp-transport";

export interface DirectAcpTransportConfig {
  /** Path to the kiro-cli binary. Defaults to "kiro-cli" (on PATH). */
  cliPath?: string;
  /** Working directory for the CLI subprocess. Defaults to process.cwd(). */
  cwd?: string;
  /** Enable debug logging (lifecycle events) on the underlying AcpClient. */
  debug?: boolean;
  /** Enable verbose logging (transport-level details) on the underlying AcpClient. Implies debug. */
  verbose?: boolean;
}

export class DirectAcpTransport implements AcpTransport {
  private client: AcpClient;
  private config: DirectAcpTransportConfig;

  constructor(config: DirectAcpTransportConfig = {}) {
    this.client = new AcpClient({ debug: config.debug, verbose: config.verbose });
    this.config = config;
  }

  async start(cwd?: string): Promise<void> {
    const cliPath = this.config.cliPath ?? "kiro-cli";
    const workDir = cwd ?? this.config.cwd ?? process.cwd();
    await this.client.start(cliPath, workDir);
  }

  async createSession(cwd?: string, systemPrompt?: string, mcpServers?: McpServerConfig[]): Promise<string> {
      const workDir = cwd ?? this.config.cwd ?? process.cwd();
      return this.client.createSession(workDir, systemPrompt, mcpServers?.map(s => ({
        name: s.name,
        command: s.command,
        args: s.args,
        env: s.env,
      })));
    }

  async sendPrompt(text: string, sessionId?: string): Promise<{ stopReason: string }> {
    if (sessionId) {
      return this.client.sendPromptToSession(sessionId, text);
    }
    return this.client.sendPrompt(text);
  }

  cancel(sessionId?: string): void {
    if (sessionId) {
      this.client.cancelSession(sessionId);
    } else {
      this.client.cancel();
    }
  }

  stop(): void {
    this.client.stop();
  }

  onUpdate(callback: AcpUpdateCallback): () => void {
    const handler = (update: unknown) => callback(update);
    this.client.on("session-update", handler);
    return () => { this.client.removeListener("session-update", handler); };
  }

  /** Expose the underlying client for advanced test assertions. */
  get acpClient(): AcpClient {
    return this.client;
  }
}
