import { app, BrowserWindow, ipcMain, dialog, session, Menu } from "electron";
import * as path from "path";
import * as fs from "fs";
import { fromIni } from "@aws-sdk/credential-providers";
import { AcpClient } from "./services/acp-client";
import type { ProtocolLogEntry } from "./services/acp-client";
import { isToolResultError } from "./utils/retry";
import { resolveKiroCliPath } from "./utils/cli-resolve";
import { DebugLogger } from "./services/debug-logger";
import type { DebugLogEntry } from "./services/debug-logger";
import { DEFAULT_AWS_REGION } from "./types";

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

let mainWindow: BrowserWindow | null = null;
let acpClient: AcpClient | null = null;

/** Display name for the application — hardcoded because app.name resolves to "Electron" in dev mode. */
const APP_DISPLAY_NAME = "ARchitect";

/** Verbose mode — enabled with ARCHITECT_VERBOSE=1. Logs low-level ACP transport details (buffer sizes, JSON-RPC framing). Implies debug mode. */
const VERBOSE_MODE = process.env.ARCHITECT_VERBOSE === "1";

/** Debug mode — enabled with ARCHITECT_DEBUG=1 (or implied by ARCHITECT_VERBOSE=1). Logs structured agent trace (tool calls, text, results) to terminal. */
const DEBUG_MODE = VERBOSE_MODE || process.env.ARCHITECT_DEBUG === "1";

/**
 * Log a formatted agent trace entry to the terminal.
 * Only called when DEBUG_MODE is true.
 *
 * Text chunks are buffered and flushed every 500ms (or when a non-text
 * event arrives) so the terminal shows readable paragraphs instead of
 * one line per tiny streaming fragment.
 */
let textBuffer = "";
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushTextBuffer(): void {
  if (textBuffer.length === 0) return;
  const ts = new Date().toISOString().slice(11, 23);
  console.log("\x1b[36m[%s text]\x1b[0m %s", ts, textBuffer);
  textBuffer = "";
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

function logAgentTrace(update: Record<string, unknown>): void {
  const type = update.sessionUpdate as string;
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm

  switch (type) {
    case "agent_message_chunk": {
      const text = (update.content as { text?: string })?.text ?? "";
      textBuffer += text;
      // Schedule a flush — resets on each chunk so we batch them up
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(flushTextBuffer, 500);
      break;
    }
    case "tool_call": {
      flushTextBuffer(); // flush any pending text before the tool call
      const title = (update.title as string) ?? "unknown";
      const status = (update.status as string) ?? "";
      const toolId = (update.toolCallId as string) ?? "";
      console.log("\x1b[33m[%s tool_call]\x1b[0m %s (%s) id=%s", ts, title, status, toolId);
      const input = update.input ?? update.arguments;
      if (input) {
        const inputStr = typeof input === "string" ? input : JSON.stringify(input, null, 2);
        console.log("\x1b[90m  input: %s\x1b[0m", inputStr);
      }
      break;
    }
    case "tool_result": {
      flushTextBuffer();
      const toolId = (update.toolCallId as string) ?? "";
      const content = update.content;
      console.log("\x1b[32m[%s tool_result]\x1b[0m id=%s", ts, toolId);
      if (content) {
        const resultStr = typeof content === "string" ? content : JSON.stringify(content, null, 2);
        const truncated = resultStr.length > 2000
          ? resultStr.slice(0, 2000) + `\n  ... (${resultStr.length} chars total, truncated)`
          : resultStr;
      console.log("\x1b[90m  result: %s\x1b[0m", truncated);
      }
      break;
    }
    default: {
      flushTextBuffer();
      console.log("\x1b[35m[%s %s]\x1b[0m", ts, type, JSON.stringify(update, null, 2));
      break;
    }
  }
}

/**
 * Log tool-use failures to the terminal regardless of debug mode.
 * Detects errors from both tool_call status and tool_result content.
 */
function logToolFailure(update: Record<string, unknown>): void {
  const type = update.sessionUpdate as string;
  const ts = new Date().toISOString().slice(11, 23);
  const toolId = (update.toolCallId as string) ?? "";

  if (type === "tool_call") {
    const status = (update.status as string) ?? "";
    if (/error|fail/i.test(status)) {
      const title = (update.title as string) ?? "unknown tool";
      console.error("\x1b[31m[%s tool_error]\x1b[0m Tool call failed: %s (status=%s) id=%s", ts, title, status, toolId);
      const input = update.input ?? update.arguments;
      if (input) {
        const inputStr = typeof input === "string" ? input : JSON.stringify(input, null, 2);
        console.error("\x1b[90m  input: %s\x1b[0m", inputStr);
      }
    }
  }

  if (type === "tool_result") {
    const content = update.content;
    const status = (update.status as string) ?? "";
    const contentStr = typeof content === "string"
      ? content
      : content ? JSON.stringify(content) : "";

    const isError = /error|fail/i.test(status)
      || isToolResultError(contentStr);

    if (isError) {
      const truncated = contentStr.length > 1000
        ? contentStr.slice(0, 1000) + `… (${contentStr.length} chars)`
        : contentStr;
      console.error("\x1b[31m[%s tool_error]\x1b[0m Tool result indicates failure id=%s", ts, toolId);
      console.error("\x1b[90m  result: %s\x1b[0m", truncated);
    }
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    icon: resolveIconPath("ARchitect_macOS@1x.png"),
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: APP_DISPLAY_NAME,
    titleBarStyle: "hiddenInset",
  });

  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
}

// ── Debug logger ──
const architectDir = path.join(app.getPath("home"), ".ARchitect");
const debugLogger = new DebugLogger(path.join(architectDir, "logs"));

/** Resolve the icon directory — extraResource places it under process.resourcesPath in packaged builds. */
function resolveIconPath(filename: string): string {
  // nosemgrep: path-join-resolve-traversal — filename is a hardcoded icon name from buildAppMenu, not user input
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon", filename) // nosemgrep: path-join-resolve-traversal
    : path.join(app.getAppPath(), "icon", filename); // nosemgrep: path-join-resolve-traversal
}

/** Build the application menu with Help → Download Debug Info. */
function buildAppMenu(): void {
  const isMac = process.platform === "darwin";

  const template: Electron.MenuItemConstructorOptions[] = [
    // macOS app menu — hardcode the label because app.name resolves to
    // "Electron" in dev mode (the binary name) rather than the product name.
    ...(isMac ? [{
      label: APP_DISPLAY_NAME,
      submenu: [
        { role: "about" as const },
        { type: "separator" as const },
        { role: "hide" as const },
        { role: "hideOthers" as const },
        { role: "unhide" as const },
        { type: "separator" as const },
        { role: "quit" as const },
      ],
    }] : []),
    // Edit menu — essential for Cmd+C/V in chat textarea
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    // View menu — developer tools (only in debug mode)
    ...(DEBUG_MODE ? [{
      label: "View",
      submenu: [
        { role: "reload" as const },
        { role: "forceReload" as const },
        { role: "toggleDevTools" as const },
        { type: "separator" as const },
        { role: "resetZoom" as const },
        { role: "zoomIn" as const },
        { role: "zoomOut" as const },
        { type: "separator" as const },
        { role: "togglefullscreen" as const },
      ],
    }] : []),
    // Window menu
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac ? [
          { type: "separator" as const },
          { role: "front" as const },
        ] : [
          { role: "close" as const },
        ]),
      ],
    },
    // Help menu with debug export
    {
      label: "Help",
      submenu: [
        {
          label: "Download Debug Info",
          accelerator: "Shift+CmdOrCtrl+D",
          click: () => {
            mainWindow?.webContents.send("debug:requestExport");
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  if (VERBOSE_MODE) {
    console.log("\x1b[33m[ARchitect] Verbose mode enabled — transport-level ACP details will be logged\x1b[0m");
  } else if (DEBUG_MODE) {
    console.log("\x1b[33m[ARchitect] Debug mode enabled — full agent trace will be logged to this terminal\x1b[0m");
  }

  // Override CSP to allow AWS SDK connections from the renderer
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https://*.amazonaws.com http://localhost:*;",
        ],
      },
    });
  });

  buildAppMenu();

  createWindow();
  debugLogger.logEvent("app-start", { version: app.getVersion(), platform: process.platform });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── IPC handlers ──

ipcMain.handle("dialog:openFile", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [
      { name: "Documents", extensions: ["pdf", "txt"] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle("dialog:openMarkdown", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [
      { name: "Markdown", extensions: ["md", "markdown"] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle("dialog:saveFile", async (_event, defaultName: string, content: string) => {
  const result = await dialog.showSaveDialog({
    defaultPath: defaultName,
    filters: [
      { name: "HTML", extensions: ["html"] },
    ],
  });
  if (result.canceled || !result.filePath) return false;
  fs.writeFileSync(result.filePath, content, "utf-8");
  return true;
});

ipcMain.handle("file:readBase64", async (_event, filePath: string) => {
  const buffer = fs.readFileSync(filePath);
  return buffer.toString("base64");
});

ipcMain.handle("file:readText", async (_event, filePath: string) => {
  return fs.readFileSync(filePath, "utf-8");
});

const metadataDir = path.join(app.getPath("userData"), "policies");
const approvalCodeFile = path.join(app.getPath("userData"), "approval-codes.json");
const contextIndexFile = path.join(app.getPath("userData"), "context-index.json");

/**
 * Resolve a metadata file path for the given policy ARN.
 * Sanitizes the ARN and verifies the resolved path stays within metadataDir
 * to prevent path traversal attacks.
 */
function safeMetadataPath(policyArn: string): string {
  const safeName = policyArn.replace(/[^a-zA-Z0-9-]/g, "_");
  const resolved = path.resolve(metadataDir, `${safeName}.json`);
  if (!resolved.startsWith(metadataDir + path.sep)) {
    throw new Error("Invalid policy ARN: path traversal detected");
  }
  return resolved;
}

ipcMain.handle("metadata:save", async (_event, policyArn: string, data: string) => {
  if (!fs.existsSync(metadataDir)) fs.mkdirSync(metadataDir, { recursive: true });
  fs.writeFileSync(safeMetadataPath(policyArn), data, "utf-8");
});

ipcMain.handle("metadata:load", async (_event, policyArn: string) => {
  const filePath = safeMetadataPath(policyArn);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8");
});

ipcMain.handle("approval:getFilePath", () => {
  return approvalCodeFile;
});

// ── Progressive import local state (~/.ARchitect/) ──

/**
 * Resolve a policy-scoped directory under architectDir.
 * Sanitizes the policyId and verifies the resolved path stays within the base directory
 * to prevent path traversal attacks.
 */
function policyStateDir(policyId: string): string {
  const safeName = policyId.replace(/[^a-zA-Z0-9-]/g, "_");
  const resolved = path.resolve(architectDir, safeName);
  if (!resolved.startsWith(architectDir + path.sep) && resolved !== architectDir) {
    throw new Error("Invalid policy ID: path traversal detected");
  }
  return resolved;
}

ipcMain.handle("localState:save", async (_event, policyId: string, data: string) => {
  const dir = policyStateDir(policyId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // nosemgrep: path-join-resolve-traversal — dir is sanitized by policyStateDir, filename is a constant
  fs.writeFileSync(path.join(dir, "state.json"), data, "utf-8");
});

ipcMain.handle("localState:load", async (_event, policyId: string) => {
  // nosemgrep: path-join-resolve-traversal — policyStateDir sanitizes policyId, filename is a constant
  const filePath = path.join(policyStateDir(policyId), "state.json");
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8");
});

ipcMain.handle("localState:saveFidelityReport", async (_event, policyId: string, buildId: string, data: string) => {
  const dir = policyStateDir(policyId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const safeBuildId = buildId.replace(/[^a-zA-Z0-9-]/g, "_");
  const resolved = path.resolve(dir, `fidelity-${safeBuildId}.json`);
  if (!resolved.startsWith(dir + path.sep)) {
    throw new Error("Invalid build ID: path traversal detected");
  }
  fs.writeFileSync(resolved, data, "utf-8");
});

ipcMain.handle("localState:saveScenarios", async (_event, policyId: string, data: string) => {
  const dir = policyStateDir(policyId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "scenarios.json"), data, "utf-8");
});

ipcMain.handle("localState:loadScenarios", async (_event, policyId: string) => {
  const filePath = path.join(policyStateDir(policyId), "scenarios.json");
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8");
});

ipcMain.handle("localState:loadFidelityReport", async (_event, policyId: string, buildId: string) => {
  const dir = policyStateDir(policyId);
  const safeBuildId = buildId.replace(/[^a-zA-Z0-9-]/g, "_");
  const filePath = path.resolve(dir, `fidelity-${safeBuildId}.json`);
  if (!filePath.startsWith(dir + path.sep)) {
    throw new Error("Invalid build ID: path traversal detected");
  }
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8");
});


ipcMain.handle("approval:writeCode", async (_event, code: string) => {
  const { writeApprovalCode } = await import("./services/approval-code-store");
  writeApprovalCode(approvalCodeFile, code);
});

// ── Context index (for MCP subprocess search tools) ──

ipcMain.handle("contextIndex:getFilePath", () => {
  return contextIndexFile;
});

ipcMain.handle("contextIndex:write", async (_event, json: string) => {
  // Atomic write: write to temp file then rename to avoid partial reads
  const tmpFile = contextIndexFile + ".tmp";
  fs.writeFileSync(tmpFile, json, "utf-8");
  fs.renameSync(tmpFile, contextIndexFile);
});

ipcMain.handle("mcp:serverPath", () => {
  const candidate = path.join(__dirname, "mcp-server.js");
  let resolved: string;
  if (app.isPackaged) {
    resolved = candidate.replace("app.asar", "app.asar.unpacked");
  } else {
    resolved = candidate;
  }
  const exists = fs.existsSync(resolved);
  debugLogger.logEvent("mcp-server-path", {
    __dirname,
    candidate,
    resolved,
    isPackaged: app.isPackaged,
    fileExists: exists,
  });
  return resolved;
});

ipcMain.handle("mcp:nodeCommand", () => {
  if (!app.isPackaged) {
    debugLogger.logEvent("mcp-node-command", { result: "node", reason: "dev-mode" });
    return "node";
  }

  const home = app.getPath("home");
  const checked: { path: string; exists: boolean }[] = [];
  const candidates = [
    ...(() => {
      const nvmDir = process.env.NVM_DIR ?? path.join(home, ".nvm");
      try {
        const alias = fs.readFileSync(path.join(nvmDir, "alias", "default"), "utf-8").trim();
        const versionDir = path.join(nvmDir, "versions", "node");
        const exactPath = path.join(versionDir, alias, "bin", "node");
        if (fs.existsSync(exactPath)) return [exactPath];
        const dirs = fs.readdirSync(versionDir).filter(d => d.startsWith("v" + alias));
        if (dirs.length > 0) {
          return [path.join(versionDir, dirs[dirs.length - 1], "bin", "node")];
        }
      } catch { /* nvm not installed or alias unreadable */ }
      if (process.env.NVM_BIN) return [path.join(process.env.NVM_BIN, "node")];
      return [];
    })(),
    path.join(home, ".fnm", "current", "bin", "node"),
    path.join(home, "Library", "Application Support", "fnm", "current", "bin", "node"),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ];

  for (const p of candidates) {
    const exists = fs.existsSync(p);
    checked.push({ path: p, exists });
    if (exists) {
      debugLogger.logEvent("mcp-node-command", {
        result: p,
        reason: "found",
        isPackaged: true,
        envPath: process.env.PATH,
        checked,
      });
      return p;
    }
  }

  debugLogger.logEvent("mcp-node-command", {
    result: "node",
    reason: "fallback-none-found",
    isPackaged: true,
    envPath: process.env.PATH,
    checked,
  }, "warn");
  return "node";
});

// Region is read synchronously — it's a single process.env read needed at renderer
// module init time. Intentionally sendSync (not invoke) to avoid async PolicyService construction.
ipcMain.on("aws:getRegionSync", (event) => {
  event.returnValue = process.env.AWS_REGION ?? DEFAULT_AWS_REGION;
});

ipcMain.handle("aws:getCredentials", async () => {
  const provider = fromIni();
  const creds = await provider();
  return {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
  };
});

// ── ACP (Kiro CLI) handlers ──

ipcMain.handle("acp:start", async (_event, cwd?: string) => {
  debugLogger.logEvent("ipc-request", { channel: "acp:start", cwd });
  if (acpClient?.isConnected) return;

  // If the previous client exists but is disconnected (process died), clean it up
  if (acpClient && !acpClient.isConnected) {
    acpClient.removeAllListeners();
    acpClient = null;
  }

  acpClient = new AcpClient({ debug: DEBUG_MODE, verbose: VERBOSE_MODE });

  // Forward streamed updates to the renderer
  acpClient.on("session-update", (update) => {
    mainWindow?.webContents.send("acp:session-update", update);

    // Always log tool failures to the terminal so they're visible without debug mode
    logToolFailure(update as Record<string, unknown>);

    // In debug mode, log the full thinking trace to the terminal
    if (DEBUG_MODE) {
      logAgentTrace(update as Record<string, unknown>);
    }

    // Structured debug log — always active.
    // Chunk merging is handled inside DebugLogger.logSessionEvent.
    debugLogger.logSessionEvent(update as Record<string, unknown>);
  });

  acpClient.on("stderr", (text: string) => {
    console.error("[kiro-cli stderr]", text);
    mainWindow?.webContents.send("acp:cli-error", { type: "stderr", message: text });
    debugLogger.logEvent("cli-stderr", { message: text }, "error");
  });

  acpClient.on("exit", (code: number | null) => {
    console.log(`[kiro-cli] exited with code ${code}`);
    mainWindow?.webContents.send("acp:cli-error", { type: "exit", code });
    debugLogger.logEvent("cli-exit", { code }, "warn");
    // Don't null out acpClient here — let the IPC handlers detect the
    // disconnected state and restart automatically on the next request.
  });

  // Handle spawn errors (e.g. ENOENT when CLI binary is missing).
  // Without this listener, Node.js EventEmitter throws on unhandled "error" events,
  // which would crash the main process.
  acpClient.on("error", (err: Error) => {
    console.error("[kiro-cli error]", err.message);
    mainWindow?.webContents.send("acp:cli-error", { type: "stderr", message: `Failed to start policy engine: ${err.message}` });
    debugLogger.logEvent("cli-error", { message: err.message }, "error");
  });

  // In debug mode, forward ACP protocol messages to the renderer DevTools console
  if (DEBUG_MODE) {
    acpClient.on("protocol-log", (entry: ProtocolLogEntry) => {
      mainWindow?.webContents.send("acp:protocol-log", entry);
    });
  }

  try {
    const cliPath = resolveKiroCliPath();
    const workDir = cwd ?? app.getPath("home");
    await acpClient.start(cliPath, workDir);
  } catch (err) {
    debugLogger.logEvent("acp-start-failed", { error: err instanceof Error ? err.message : String(err) }, "error");
    acpClient?.removeAllListeners();
    acpClient = null;
    throw new Error(`Failed to start policy engine: ${err instanceof Error ? err.message : String(err)}`);
  }
});

ipcMain.handle("acp:createSession", async (_event, cwd?: string, systemPrompt?: string, mcpServers?: { name: string; command: string; args: string[]; env?: Record<string, string> }[]) => {
  debugLogger.logEvent("ipc-request", {
    channel: "acp:createSession",
    cwd,
    mcpServerCount: mcpServers?.length ?? 0,
    mcpServers: mcpServers?.map(s => ({
      name: s.name,
      command: s.command,
      args: s.args,
      envKeys: Object.keys(s.env ?? {}),
    })),
  });
  if (!acpClient?.isConnected) throw new Error("ACP client not started");
  const workDir = cwd ?? app.getPath("home");
  try {
    const sessionId = await acpClient.createSession(workDir, systemPrompt, mcpServers);
    debugLogger.logEvent("acp-session-created", { sessionId, mcpServerCount: mcpServers?.length ?? 0 });
    return sessionId;
  } catch (err) {
    debugLogger.logEvent("acp-session-failed", {
      error: err instanceof Error ? err.message : String(err),
      mcpServerCount: mcpServers?.length ?? 0,
    }, "error");
    throw err;
  }
});

ipcMain.handle("acp:sendPrompt", async (_event, text: string, sessionId?: string) => {
  debugLogger.logEvent("ipc-request", { channel: "acp:sendPrompt", sessionId, promptLength: text.length });
  if (!acpClient?.isConnected) throw new Error("ACP client not started");
  try {
    if (sessionId && acpClient.hasSession(sessionId)) {
      return await acpClient.sendPromptToSession(sessionId, text);
    }
    return await acpClient.sendPrompt(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Preserve cancellation errors as-is so the renderer can distinguish
    // user-initiated cancels from transient failures. Wrapping them in
    // "ACP error:" would cause isAcpTransientError to misclassify them.
    if (message.includes("cancelled")) {
      throw err;
    }
    // Re-throw with enough context for the renderer to classify the error
    throw new Error(`ACP error: ${message}`);
  }
});

ipcMain.on("acp:cancel", (_event, sessionId?: string) => {
  if (sessionId && acpClient?.hasSession(sessionId)) {
    acpClient.cancelSession(sessionId);
  } else {
    acpClient?.cancel();
  }
});

ipcMain.on("acp:stop", () => {
  acpClient?.stop();
  acpClient = null;
});

// Clean up ACP subprocess and debug logger on app quit
app.on("before-quit", () => {
  debugLogger.close();
  acpClient?.stop();
});

// ── Debug logging from renderer ──

const VALID_LOG_LEVELS: ReadonlySet<DebugLogEntry["level"]> = new Set(["info", "warn", "error"]);

ipcMain.handle("debug:logRendererEvent", (_event, category: string, data: Record<string, unknown>, level?: string) => {
  const safeLevel: DebugLogEntry["level"] = VALID_LOG_LEVELS.has(level as DebugLogEntry["level"])
    ? (level as DebugLogEntry["level"])
    : "warn";
  debugLogger.logEvent(category, data, safeLevel);
});

// ── Debug export ──

ipcMain.handle("debug:export", async (_event, stateSnapshot: string) => {
  const recentLogs = debugLogger.readRecentEntries(1000);

  const exportData = {
    exportedAt: new Date().toISOString(),
    app: {
      name: APP_DISPLAY_NAME,
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
    },
    stateSnapshot: JSON.parse(stateSnapshot),
    recentLogs,
  };

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const defaultName = `ARchitect-debug-${timestamp}.json`;

  const result = await dialog.showSaveDialog({
    defaultPath: path.join(app.getPath("downloads"), defaultName),
    filters: [{ name: "JSON", extensions: ["json"] }],
  });

  if (result.canceled || !result.filePath) return null;

  fs.writeFileSync(result.filePath, JSON.stringify(exportData, null, 2), "utf-8");
  debugLogger.logEvent("debug-export", { filePath: result.filePath });

  return result.filePath;
});
