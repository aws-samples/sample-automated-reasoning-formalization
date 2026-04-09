import { contextBridge, ipcRenderer } from "electron";
import type { ArchitectAPI } from "./types/preload";
import type { CliErrorEvent } from "./types";

const api: ArchitectAPI = {
  // ── File dialogs ──
  openFileDialog: (): Promise<string | null> =>
    ipcRenderer.invoke("dialog:openFile"),
  openMarkdownDialog: (): Promise<string | null> =>
    ipcRenderer.invoke("dialog:openMarkdown"),
  saveFileDialog: (defaultName: string, content: string): Promise<boolean> =>
    ipcRenderer.invoke("dialog:saveFile", defaultName, content),
  readFileBase64: (path: string): Promise<string> =>
    ipcRenderer.invoke("file:readBase64", path),
  readFileText: (path: string): Promise<string> =>
    ipcRenderer.invoke("file:readText", path),

  // ── Policy metadata persistence ──
  saveMetadata: (policyArn: string, data: string): Promise<void> =>
    ipcRenderer.invoke("metadata:save", policyArn, data),
  loadMetadata: (policyArn: string): Promise<string | null> =>
    ipcRenderer.invoke("metadata:load", policyArn),

  // ── Progressive import local state ──
  saveLocalState: (policyId: string, data: string): Promise<void> =>
    ipcRenderer.invoke("localState:save", policyId, data),
  loadLocalState: (policyId: string): Promise<string | null> =>
    ipcRenderer.invoke("localState:load", policyId),
  saveFidelityReport: (policyId: string, buildId: string, data: string): Promise<void> =>
    ipcRenderer.invoke("localState:saveFidelityReport", policyId, buildId, data),
  loadFidelityReport: (policyId: string, buildId: string): Promise<string | null> =>
    ipcRenderer.invoke("localState:loadFidelityReport", policyId, buildId),

  // ── Policy scenarios persistence ──
  saveScenarios: (policyId: string, data: string): Promise<void> =>
    ipcRenderer.invoke("localState:saveScenarios", policyId, data),
  loadScenarios: (policyId: string): Promise<string | null> =>
    ipcRenderer.invoke("localState:loadScenarios", policyId),

  // ── MCP server path ──
  getMcpServerPath: (): Promise<string> =>
    ipcRenderer.invoke("mcp:serverPath"),
  getNodeCommand: (): Promise<string> =>
    ipcRenderer.invoke("mcp:nodeCommand"),

  // ── Approval codes ──
  getApprovalCodeFilePath: (): Promise<string> =>
    ipcRenderer.invoke("approval:getFilePath"),
  writeApprovalCode: (code: string): Promise<void> =>
    ipcRenderer.invoke("approval:writeCode", code),

  // ── Context index (for MCP subprocess search tools) ──
  getContextIndexFilePath: (): Promise<string> =>
    ipcRenderer.invoke("contextIndex:getFilePath"),
  writeContextIndex: (json: string): Promise<void> =>
    ipcRenderer.invoke("contextIndex:write", json),

  // ── AWS region + credentials ──
  getRegion: (): string => ipcRenderer.sendSync("aws:getRegionSync"),
  getCredentials: (): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }> =>
    ipcRenderer.invoke("aws:getCredentials"),

  // ── ACP (Kiro CLI) ──
  acpStart: (cwd?: string): Promise<void> =>
    ipcRenderer.invoke("acp:start", cwd),
  acpCreateSession: (cwd?: string, systemPrompt?: string, mcpServers?: { name: string; command: string; args: string[]; env?: Record<string, string> }[]): Promise<string> =>
    ipcRenderer.invoke("acp:createSession", cwd, systemPrompt, mcpServers),
  acpSendPrompt: (text: string, sessionId?: string): Promise<{ stopReason: string }> =>
    ipcRenderer.invoke("acp:sendPrompt", text, sessionId),
  acpCancel: (sessionId?: string): void =>
    ipcRenderer.send("acp:cancel", sessionId),
  acpStop: (): void => {
    ipcRenderer.send("acp:stop");
  },
  onAcpUpdate: (() => {
    const listeners = new Set<(update: unknown) => void>();
    // Register the IPC listener once — dispatches to all registered callbacks
    ipcRenderer.on("acp:session-update", (_event, update) => {
      for (const cb of listeners) cb(update);
    });
    return (callback: (update: unknown) => void): (() => void) => {
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    };
  })(),
  onAcpCliError: (() => {
    const listeners = new Set<(error: CliErrorEvent) => void>();
    ipcRenderer.on("acp:cli-error", (_event, error) => {
      for (const cb of listeners) cb(error as CliErrorEvent);
    });
    return (callback: (error: CliErrorEvent) => void): (() => void) => {
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    };
  })(),

  // ── Debug ──
  exportDebugInfo: (stateSnapshot: string): Promise<string | null> =>
    ipcRenderer.invoke("debug:export", stateSnapshot),
  logRendererEvent: (category: string, data: Record<string, unknown>, level?: string): Promise<void> =>
    ipcRenderer.invoke("debug:logRendererEvent", category, data, level),
  onDebugExportRequested: (() => {
    const listeners = new Set<() => void>();
    ipcRenderer.on("debug:requestExport", () => {
      for (const cb of listeners) cb();
    });
    return (callback: () => void): (() => void) => {
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    };
  })(),
};

contextBridge.exposeInMainWorld("architect", api);

// ── ACP Protocol logging (debug mode) ──
// This listener is always registered but only receives messages when DEBUG_MODE
// is active in main.ts — the IPC event is never sent in production.
ipcRenderer.on("acp:protocol-log", (_event, entry: { direction: "incoming" | "outgoing"; message: unknown }) => {
  const msg = entry.message as Record<string, unknown>;
  const arrow = entry.direction === "outgoing" ? "⬆️ ACP REQ" : "⬇️ ACP RES";
  const label = msg.method ?? `id:${msg.id}`;
  console.groupCollapsed(`[${arrow}]`, label);
  console.log(JSON.stringify(msg, null, 2));
  console.groupEnd();
});
