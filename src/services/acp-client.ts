/**
 * ACP (Agent Client Protocol) client for communicating with Kiro CLI.
 *
 * Manages the JSON-RPC 2.0 lifecycle over stdio:
 *   initialize → session/new → session/prompt (with streamed session/update notifications)
 *
 * This runs in the main (Node.js) process and is exposed to the renderer via IPC.
 */
import { ChildProcess, spawn } from "child_process";
import { EventEmitter } from "events";

// ── JSON-RPC types ──

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Server-to-client request (e.g., tool approval). Has both id and method. */
interface JsonRpcServerRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcServerRequest | JsonRpcNotification;

// ── Logging ──

type LogLevel = "debug" | "verbose";

// ── ACP-specific types ──

export interface AcpSessionUpdate {
  sessionId: string;
  update: {
    sessionUpdate: string;
    content?: { type: string; text: string };
    toolCallId?: string;
    status?: string;
    title?: string;
    entries?: unknown[];
    [key: string]: unknown;
  };
}

export interface AcpPromptResult {
  stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
}

/** Shape of the protocol-log event emitted in debug mode for DevTools inspection. */
export interface ProtocolLogEntry {
  direction: "incoming" | "outgoing";
  message: unknown;
}

export class AcpClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = "";
  /** @deprecated Use sessions map instead. Kept for backward compat with currentSessionId getter. */
  private sessionId: string | null = null;
  /** All active session IDs managed by this client. */
  private sessions = new Set<string>();
  /** Maps session ID → pending prompt request ID, so cancelSession can reject it immediately. */
  private activePromptRequests = new Map<string, number>();
  private initialized = false;
  private debug: boolean;
  private verbose: boolean;

  /**
   * @param options.debug — When true, logs lifecycle events (start, session, errors) to stderr.
   * @param options.verbose — When true, also logs transport-level details (buffer sizes, JSON-RPC framing, pending requests).
   */
  constructor(options?: { debug?: boolean; verbose?: boolean }) {
    super();
    this.verbose = options?.verbose ?? false;
    this.debug = this.verbose || (options?.debug ?? false);
  }

  private log(level: LogLevel, tag: string, ...args: unknown[]): void {
    if (level === "verbose" && !this.verbose) return;
    if (level === "debug" && !this.debug) return;
    console.error("[AcpClient:%s]", tag, ...args);
  }

  /**
   * Spawn the Kiro CLI subprocess and initialize the ACP connection.
   */
  async start(cliPath: string, cwd: string): Promise<void> {
    if (this.process) return;

    // Validate cliPath to prevent command injection — must be an absolute path
    // or a bare binary name (no shell metacharacters).
    if (!/^[a-zA-Z0-9_\-./\\:]+$/.test(cliPath)) {
      throw new Error(`Invalid CLI path: ${cliPath}`);
    }

    this.log("debug", "start", `Spawning: ${cliPath} acp (cwd: ${cwd})`);
    // nosemgrep: detect-child-process — cliPath is validated above and resolved from known install locations via resolveKiroCliPath
    this.process = spawn(cliPath, ["acp"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.log("debug", "start", `Process spawned, pid: ${this.process.pid}`);

    const proc = this.process;
    proc.stdout!.on("data", (chunk: Buffer) => {
      this.log("verbose", "stdout", `Received ${chunk.length} bytes`);
      this.onData(chunk);
    });
    proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      this.log("verbose", "stderr", text.trimEnd());
      this.emit("stderr", text);
    });
    proc.on("exit", (code, signal) => {
      this.log("debug", "lifecycle", `Process exited — code: ${code}, signal: ${signal}`);
      // Only clean up if this is still the active process (guards against
      // stale exit events from a previously-stopped process).
      if (this.process === proc) {
        this.emit("exit", code);
        this.cleanup();
      } else {
        this.log("verbose", "lifecycle", "Ignoring stale exit event from previous process");
      }
    });
    proc.on("error", (err) => {
      this.log("debug", "lifecycle", `Process error: ${err.message}`);
      if (this.process === proc) {
        this.emit("error", err);
        this.cleanup();
      }
    });

    // ACP initialize handshake
    this.log("debug", "start", "Sending initialize request...");
    const initResult = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: {
        name: "architect",
        title: "ARchitect",
        version: "0.1.0",
      },
    }) as Record<string, unknown>;

    this.log("debug", "start", "Initialize response received:", JSON.stringify(initResult));
    this.initialized = true;
    this.emit("initialized", initResult);
  }

  /**
   * Create a new ACP session.
   * @param cwd Working directory for the session.
   * @param systemPrompt Optional system prompt that configures agent behavior for the session.
   * @param mcpServers Optional MCP server configurations to register with the session.
   */
  async createSession(
    cwd: string,
    systemPrompt?: string,
    mcpServers?: { name: string; command: string; args: string[]; env?: Record<string, string> }[],
  ): Promise<string> {
    if (!this.initialized) throw new Error("ACP client not initialized");

    // The ACP protocol (zMcpServerStdio) expects env as an array of { name, value }
    // objects, not a Record<string, string>. Convert our internal format.
    const sanitized = (mcpServers ?? []).map(s => ({
      name: s.name,
      command: s.command,
      args: s.args,
      env: Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value })),
    }));

    const params: Record<string, unknown> = {
      cwd,
      mcpServers: sanitized,
    };
    if (systemPrompt) {
      params.systemPrompt = systemPrompt;
    }

    this.log("debug", "createSession", `Requesting session (cwd: ${cwd}, hasPrompt: ${!!systemPrompt}, mcpServers: ${sanitized.length})`);
    const result = await this.request("session/new", params) as { sessionId: string };
    this.log("debug", "createSession", `Session created: ${result.sessionId}`);
    this.sessionId = result.sessionId;
    this.sessions.add(result.sessionId);

    // Switch to Opus 4.6 model for the session
    await this.setModel(result.sessionId, "claude-opus-4.6");

    return result.sessionId;
  }

  /**
   * Set the model for a specific session via session/set_model.
   */
  async setModel(sessionId: string, modelId: string): Promise<void> {
    if (!this.sessions.has(sessionId)) throw new Error(`Unknown session: ${sessionId}`);
    this.log("debug", "setModel", `Setting model to ${modelId} for session ${sessionId}`);
    await this.request("session/set_model", {
      sessionId,
      modelId,
    });
    this.log("debug", "setModel", `Model set to ${modelId}`);
  }

  /**
   * Send a prompt to a specific session and collect the full response.
   * Emits "session-update" events for each streamed notification.
   * Returns when the agent finishes the turn.
   */
  async sendPromptToSession(sessionId: string, text: string): Promise<AcpPromptResult> {
    if (!this.sessions.has(sessionId)) throw new Error(`Unknown session: ${sessionId}`);

    this.log("debug", "sendPrompt", `Sending prompt (${text.length} chars) to session ${sessionId}`);

    // Track the request so cancelSession can reject it immediately.
    const id = this.nextId; // peek at the ID that request() will use
    this.activePromptRequests.set(sessionId, id);

    try {
      const result = await this.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }],
      }) as AcpPromptResult;

      this.log("debug", "sendPrompt", `Prompt complete — stopReason: ${result.stopReason}`);
      return result;
    } finally {
      // Clean up tracking if this was still the active request
      if (this.activePromptRequests.get(sessionId) === id) {
        this.activePromptRequests.delete(sessionId);
      }
    }
  }

  /**
   * Send a prompt to the most recently created session.
   * @deprecated Prefer sendPromptToSession for multi-session support.
   */
  async sendPrompt(text: string): Promise<AcpPromptResult> {
    if (!this.sessionId) throw new Error("No active session");
    return this.sendPromptToSession(this.sessionId, text);
  }

  /**
   * Cancel the current prompt turn for a specific session.
   */
  cancelSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return;
    this.notify("session/cancel", { sessionId });

    // Immediately reject the in-flight prompt request so the caller
    // doesn't have to wait for the server round-trip before sending a new prompt.
    const pendingId = this.activePromptRequests.get(sessionId);
    if (pendingId !== undefined) {
      const entry = this.pending.get(pendingId);
      if (entry) {
        this.pending.delete(pendingId);
        this.activePromptRequests.delete(sessionId);
        entry.reject(new Error("Prompt cancelled by user"));
      }
    }
  }

  /**
   * Cancel the current prompt turn on the most recently created session.
   * @deprecated Prefer cancelSession for multi-session support.
   */
  cancel(): void {
    if (!this.sessionId) return;
    this.cancelSession(this.sessionId);
  }

  /**
   * Gracefully shut down the subprocess.
   */
  stop(): void {
    if (this.process) {
      const proc = this.process;
      proc.kill("SIGTERM");
      this.cleanup();
      // Emit exit synchronously so callers can await it.
      // The async 'exit' event from the child process is suppressed by the
      // stale-process guard since cleanup() already nulled this.process.
      this.log("debug", "stop", "Emitting exit event");
      this.emit("exit", null);
    } else {
      this.log("debug", "stop", "No process to stop");
    }
  }

  get isConnected(): boolean {
    return this.initialized && this.process !== null;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  /** Check whether a specific session is known to this client. */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  // ── Private: JSON-RPC transport ──

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        this.log("debug", "request", `Cannot send [${method}] — process not running`);
        return reject(new Error("ACP process not running"));
      }

      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });

      const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      this.log("verbose", "send", `→ [${id}] ${method} (pending: [${[...this.pending.keys()].join(",")}])`);
      this.send(msg);
    });
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.send(msg);
  }

  private send(msg: JsonRpcRequest | JsonRpcNotification): void {
    if (!this.process?.stdin?.writable) {
      this.log("verbose", "send", "Dropped message — stdin not writable");
      return;
    }
    const json = JSON.stringify(msg);
    this.process.stdin.write(json + "\n");
    if (this.debug) {
      this.emit("protocol-log", { direction: "outgoing", message: msg } satisfies ProtocolLogEntry);
    }
  }

  /**
   * Parse incoming data. Supports newline-delimited JSON (primary)
   * and Content-Length framing (LSP-style, fallback).
   */
  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    this.log("verbose", "onData", `Buffer now ${this.buffer.length} chars, pending requests: [${[...this.pending.keys()].join(",")}]`);

    // Try Content-Length framing first — process ALL complete messages in the buffer
    let processedContentLength = false;
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) break;

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + contentLength) break; // wait for more data

      const body = this.buffer.slice(bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.slice(bodyStart + contentLength);

      this.log("verbose", "onData", `Content-Length message (${contentLength} bytes)`);
      this.handleMessage(body);
      processedContentLength = true;
    }

    // If we only saw Content-Length messages and the buffer is empty or
    // starts with another incomplete Content-Length header, stop here.
    if (processedContentLength && (this.buffer.length === 0 || this.buffer.includes("Content-Length"))) {
      return;
    }

    // Newline-delimited JSON (primary path for kiro-cli)
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? ""; // keep incomplete last line

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        this.handleMessage(trimmed);
      }
    }
  }

  private handleMessage(raw: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.log("verbose", "parse", `Failed to parse message (${raw.length} chars): ${raw.slice(0, 200)}`);
      return;
    }

    if (this.debug) {
      this.emit("protocol-log", { direction: "incoming", message: msg } satisfies ProtocolLogEntry);
    }

    // Server-to-client request: has both `id` and `method` (e.g., tool approval prompts).
    // Auto-approve by responding with the ACP-specified outcome format.
    if ("id" in msg && "method" in msg && msg.id !== undefined && (msg as unknown as Record<string, unknown>).method) {
      const serverReq = msg as JsonRpcServerRequest;
      this.log("verbose", "recv", `← server request [${serverReq.id}] ${serverReq.method}`);

      // Build the appropriate response based on the request method.
      // session/request_permission requires an outcome with a selected optionId.
      let result: Record<string, unknown> = {};
      if (serverReq.method === "session/request_permission") {
        // Find the first "allow" option from the request, or fall back to the first option.
        const options = (serverReq.params?.options as Array<{ optionId: string; kind?: string }>) ?? [];
        const allowOption = options.find((o) => o.kind?.startsWith("allow")) ?? options[0];
        const optionId = allowOption?.optionId ?? "allow-once";
        result = { outcome: { outcome: "selected", optionId } };
        this.log("verbose", "recv", `Auto-approving permission request with optionId=${optionId}`);
      }

      const response = JSON.stringify({ jsonrpc: "2.0", id: serverReq.id, result });
      if (this.process?.stdin?.writable) {
        this.process.stdin.write(response + "\n");
        this.log("verbose", "send", `→ server request response [${serverReq.id}]`);
      }
      return;
    }

    if ("id" in msg && msg.id !== undefined) {
      // Response to a client request
      const pending = this.pending.get(msg.id as number);
      if (pending) {
        this.pending.delete(msg.id as number);
        if ((msg as JsonRpcResponse).error) {
          const err = (msg as JsonRpcResponse).error!;
          this.log("debug", "recv", `← [${msg.id}] ERROR ${err.code}: ${err.message}`);
          pending.reject(new Error(`ACP error ${err.code}: ${err.message}`));
        } else {
          this.log("verbose", "recv", `← [${msg.id}] OK — result keys: ${(msg as JsonRpcResponse).result ? Object.keys((msg as JsonRpcResponse).result as Record<string, unknown>).join(",") : "null"}`);
          pending.resolve((msg as JsonRpcResponse).result);
        }
      } else {
        this.log("verbose", "recv", `← [${msg.id}] (orphaned response — no pending handler)`);
      }
    } else if ("method" in msg) {
      // Notification from the agent (no id)
      this.log("verbose", "recv", `← notification: ${(msg as JsonRpcNotification).method}`);
      this.handleNotification(msg as JsonRpcNotification);
    } else {
      this.log("verbose", "recv", `← unknown message shape: ${raw.slice(0, 200)}`);
    }
  }

  private handleNotification(msg: JsonRpcNotification): void {
    if (msg.method === "session/update" && msg.params) {
      // The notification params are { sessionId, update: { sessionUpdate, content, ... } }.
      // Emit the inner update object with sessionId attached so consumers can route by session.
      const params = msg.params as { sessionId?: string; update?: Record<string, unknown> };
      const update = params.update ?? msg.params;
      // Attach sessionId to the update so ChatService instances can filter
      if (params.sessionId && typeof update === "object") {
        (update as Record<string, unknown>).sessionId = params.sessionId;
      }
      this.emit("session-update", update);
    } else {
      this.emit("notification", msg);
    }
  }

  private cleanup(): void {
    this.log("debug", "cleanup", `Cleaning up. Process: ${this.process?.pid ?? "null"}, pending: [${[...this.pending.keys()].join(",")}], buffer: ${this.buffer.length} chars`);
    this.process = null;
    this.sessionId = null;
    this.sessions.clear();
    this.initialized = false;
    this.buffer = "";
    for (const [id, p] of this.pending) {
      this.log("verbose", "cleanup", `Rejecting pending request [${id}]`);
      p.reject(new Error("ACP process terminated"));
    }
    this.pending.clear();
  }
}
