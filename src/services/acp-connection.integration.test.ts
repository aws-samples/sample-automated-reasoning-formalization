/**
 * Integration test for the ACP connection lifecycle.
 *
 * Exercises the real AcpClient → kiro-cli subprocess path without Electron.
 * Uses DirectAcpTransport so we can test and debug the connection independently
 * of the full UI.
 *
 * Prerequisites:
 *   - kiro-cli must be installed and on PATH (or at ~/.local/bin/kiro-cli)
 *   - Valid AWS credentials available (for the ACP session)
 *
 * Run with:
 *   npm run test:acp
 *
 * These tests are excluded from the default test suite (see vitest.config.ts)
 * because they require external dependencies. Run them explicitly when debugging
 * connection issues.
 */
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { existsSync } from "fs";
import { execSync } from "child_process";
import { AcpClient } from "./acp-client";
import { DirectAcpTransport } from "./direct-acp-transport";
import { ChatService } from "./chat-service";
import { resolveKiroCliPath, canResolve } from "../utils/cli-resolve";

const CLI_PATH = resolveKiroCliPath();
const CWD = process.cwd();

/** Timeout for operations that talk to the CLI subprocess. */
const CONNECT_TIMEOUT = 30_000;
const PROMPT_TIMEOUT = 60_000;

/** Enable debug logging — set to true to see JSON-RPC traffic. */
const DEBUG = true;

function log(msg: string): void {
  console.error(`[test] ${msg}`);
}

// ── Pre-flight checks ──

beforeAll(() => {
  log(`CLI_PATH: ${CLI_PATH}`);
  log(`CWD: ${CWD}`);

  const resolvedPath = resolveKiroCliPath();
  const onPath = canResolve(resolvedPath);
  log(`Resolved CLI path: ${resolvedPath} (reachable: ${onPath})`);

  if (!onPath && !existsSync(resolvedPath)) {
    log("WARNING: kiro-cli not found. Tests will fail at spawn.");
  }

  // Check if the resolved binary is executable
  if (existsSync(resolvedPath)) {
    try {
      const version = execSync(`${resolvedPath} --version 2>&1`, { timeout: 5000 }).toString().trim();
      log(`kiro-cli version: ${version}`);
    } catch (err) {
      log(`kiro-cli --version failed: ${(err as Error).message}`);
    }
  }
});

// ── Tests ──

describe("AcpClient — raw connection", () => {
  let client: AcpClient;

  afterEach(() => {
    log("Stopping AcpClient...");
    client?.stop();
    log("AcpClient stopped");
  });

  it("starts the kiro-cli subprocess and completes the initialize handshake", async () => {
    client = new AcpClient({ debug: DEBUG });

    let initResult: unknown;
    client.on("initialized", (result: unknown) => {
      initResult = result;
    });

    client.on("error", (err: Error) => {
      log(`AcpClient error event: ${err.message}`);
    });

    log("Starting AcpClient...");
    await client.start(CLI_PATH, CWD);
    log("AcpClient started");

    expect(client.isConnected).toBe(true);
    expect(initResult).toBeDefined();
  }, CONNECT_TIMEOUT);

  it("creates a session after initialization", async () => {
    client = new AcpClient({ debug: DEBUG });

    client.on("error", (err: Error) => {
      log(`AcpClient error event: ${err.message}`);
    });

    client.on("exit", (code: number | null) => {
      log(`AcpClient exit event: code=${code}`);
    });

    log("Starting AcpClient...");
    try {
      await client.start(CLI_PATH, CWD);
      log("AcpClient started successfully");
    } catch (err) {
      log(`AcpClient start FAILED: ${(err as Error).message}`);
      throw err;
    }

    log("Creating session...");
    try {
      const sessionId = await client.createSession(CWD);
      log(`Session created: ${sessionId}`);

      expect(sessionId).toBeTruthy();
      expect(typeof sessionId).toBe("string");
      expect(client.currentSessionId).toBe(sessionId);
    } catch (err) {
      log(`createSession FAILED: ${(err as Error).message}`);
      throw err;
    }
  }, CONNECT_TIMEOUT);

  it("sends a simple prompt and receives a response", async () => {
    client = new AcpClient({ debug: DEBUG });

    client.on("error", (err: Error) => {
      log(`AcpClient error event: ${err.message}`);
    });

    log("Starting AcpClient...");
    await client.start(CLI_PATH, CWD);
    log("Creating session...");
    await client.createSession(CWD);

    const updates: unknown[] = [];
    client.on("session-update", (update: unknown) => {
      updates.push(update);
    });

    log("Sending prompt...");
    const result = await client.sendPrompt("Reply with exactly: PING_OK");
    log(`Prompt result: ${JSON.stringify(result)}`);
    log(`Received ${updates.length} streamed updates`);

    expect(result).toBeDefined();
    expect(result.stopReason).toBeTruthy();
    expect(updates.length).toBeGreaterThan(0);
  }, PROMPT_TIMEOUT);

  it("emits exit event when stopped", async () => {
    client = new AcpClient({ debug: DEBUG });
    await client.start(CLI_PATH, CWD);

    const exitPromise = new Promise<number | null>((resolve) => {
      client.on("exit", resolve);
    });

    log("Stopping client...");
    client.stop();

    const code = await exitPromise;
    log(`Exit code: ${code}`);
    expect(client.isConnected).toBe(false);
    expect(code).toBeDefined();
  }, CONNECT_TIMEOUT);
});

describe("DirectAcpTransport — transport layer", () => {
  let transport: DirectAcpTransport;

  afterEach(() => {
    log("Stopping transport...");
    transport?.stop();
    log("Transport stopped");
  });

  it("connects and creates a session through the transport interface", async () => {
    transport = new DirectAcpTransport({ cliPath: CLI_PATH, cwd: CWD, debug: DEBUG });

    log("Starting transport...");
    await transport.start();
    log("Creating session via transport...");
    const sessionId = await transport.createSession();
    log(`Session: ${sessionId}`);

    expect(transport.acpClient.isConnected).toBe(true);
    expect(sessionId).toBeTruthy();
  }, CONNECT_TIMEOUT);

  it("receives streamed updates via onUpdate callback", async () => {
    transport = new DirectAcpTransport({ cliPath: CLI_PATH, cwd: CWD, debug: DEBUG });
    await transport.start();
    await transport.createSession();

    const updates: unknown[] = [];
    transport.onUpdate((update) => updates.push(update));

    log("Sending prompt via transport...");
    await transport.sendPrompt("Reply with exactly: TRANSPORT_OK");
    log(`Received ${updates.length} updates`);

    expect(updates.length).toBeGreaterThan(0);
  }, PROMPT_TIMEOUT);
});

describe("ChatService — end-to-end with DirectAcpTransport", () => {
  let chatService: ChatService;
  let transport: DirectAcpTransport;

  afterEach(() => {
    log("Disconnecting ChatService...");
    chatService?.disconnect();
    log("ChatService disconnected");
  });

  it("connects without hanging or timing out", async () => {
    transport = new DirectAcpTransport({ cliPath: CLI_PATH, cwd: CWD, debug: DEBUG });
    chatService = new ChatService({ transport });

    log("Connecting ChatService...");
    await chatService.connect();
    log("ChatService connected");

    expect(chatService.isConnected).toBe(true);
  }, CONNECT_TIMEOUT);

  it("connects with a system prompt", async () => {
    transport = new DirectAcpTransport({ cliPath: CLI_PATH, cwd: CWD, debug: DEBUG });
    chatService = new ChatService({ transport });

    log("Connecting ChatService with system prompt...");
    await chatService.connect("You are a helpful test assistant. Be brief.");
    log("ChatService connected with system prompt");

    expect(chatService.isConnected).toBe(true);
  }, CONNECT_TIMEOUT);

  it("sends a policy message and receives a response", async () => {
    transport = new DirectAcpTransport({ cliPath: CLI_PATH, cwd: CWD, debug: DEBUG });
    chatService = new ChatService({ transport });
    await chatService.connect("You are a test assistant. Reply briefly.");

    const updates: unknown[] = [];
    chatService.onUpdate = (update) => updates.push(update);

    log("Sending policy message...");
    const response = await chatService.sendPolicyMessage(
      "What is 2 + 2? Reply with just the number."
    );
    log(`Response: ${response.content.slice(0, 200)}`);
    log(`Updates received: ${updates.length}`);

    expect(response).toBeDefined();
    expect(response.role).toBe("assistant");
    expect(response.content).toBeTruthy();
    expect(response.id).toBeTruthy();
    expect(response.timestamp).toBeGreaterThan(0);
  }, PROMPT_TIMEOUT);

  it("disconnect cleans up the subprocess", async () => {
    transport = new DirectAcpTransport({ cliPath: CLI_PATH, cwd: CWD, debug: DEBUG });
    chatService = new ChatService({ transport });
    await chatService.connect();

    log("Disconnecting...");
    chatService.disconnect();

    expect(chatService.isConnected).toBe(false);
    expect(transport.acpClient.isConnected).toBe(false);
  }, CONNECT_TIMEOUT);
});
