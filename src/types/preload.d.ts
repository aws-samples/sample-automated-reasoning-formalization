/**
 * Single source of truth for the preload bridge API shape.
 *
 * Used by:
 *   - src/preload.ts (implementation)
 *   - src/renderer.ts (declare global Window.architect)
 */

import type { CliErrorEvent } from './index';

export interface ArchitectAPI {
  // ── File dialogs ──
  openFileDialog: () => Promise<string | null>;
  openMarkdownDialog: () => Promise<string | null>;
  saveFileDialog: (defaultName: string, content: string) => Promise<boolean>;
  readFileBase64: (path: string) => Promise<string>;
  readFileText: (path: string) => Promise<string>;

  // ── Policy metadata persistence ──
  saveMetadata: (policyArn: string, data: string) => Promise<void>;
  loadMetadata: (policyArn: string) => Promise<string | null>;

  // ── AWS region + credentials ──
  /** Synchronous — region is fixed at process start (read from AWS_REGION env var). */
  getRegion: () => string;
  getCredentials: () => Promise<{
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  }>;

  // ── MCP server path ──
  getMcpServerPath: () => Promise<string>;
  getNodeCommand: () => Promise<string>;

  // ── Approval codes ──
  getApprovalCodeFilePath: () => Promise<string>;
  writeApprovalCode: (code: string) => Promise<void>;

  // ── Context index ──
  getContextIndexFilePath: () => Promise<string>;
  writeContextIndex: (json: string) => Promise<void>;

  // ── Progressive import local state ──
  saveLocalState: (policyId: string, data: string) => Promise<void>;
  loadLocalState: (policyId: string) => Promise<string | null>;
  saveFidelityReport: (policyId: string, buildId: string, data: string) => Promise<void>;
  loadFidelityReport: (policyId: string, buildId: string) => Promise<string | null>;

  // ── Policy scenarios persistence ──
  saveScenarios: (policyId: string, data: string) => Promise<void>;
  loadScenarios: (policyId: string) => Promise<string | null>;

  // ── ACP (Kiro CLI) ──
  acpStart: (cwd?: string) => Promise<void>;
  acpCreateSession: (
    cwd?: string,
    systemPrompt?: string,
    mcpServers?: { name: string; command: string; args: string[]; env?: Record<string, string> }[],
  ) => Promise<string>;
  acpSendPrompt: (text: string, sessionId?: string) => Promise<{ stopReason: string }>;
  acpCancel: (sessionId?: string) => void;
  acpStop: () => void;
  onAcpUpdate: (callback: (update: unknown) => void) => (() => void) | void;
  onAcpCliError: (callback: (error: CliErrorEvent) => void) => (() => void);

  // ── Debug ──
  exportDebugInfo: (stateSnapshot: string) => Promise<string | null>;
  onDebugExportRequested: (callback: () => void) => (() => void);
  logRendererEvent: (category: string, data: Record<string, unknown>, level?: string) => Promise<void>;
}
