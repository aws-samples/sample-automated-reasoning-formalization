#!/usr/bin/env node
/**
 * Standalone entry point for the policy workflow MCP server.
 *
 * Spawned by the Kiro CLI as a subprocess when the ACP session starts.
 * Communicates via stdin/stdout using the MCP protocol (JSON-RPC).
 *
 * Creates its own PolicyService + PolicyWorkflowService instances
 * using the default AWS credential chain (fromIni — reads ~/.aws/credentials,
 * same source as the main Electron process).
 *
 * Environment variables:
 *   AWS_REGION — AWS region (default: us-west-2)
 *   AWS_PROFILE — AWS profile for credentials
 */
import { fromIni } from "@aws-sdk/credential-providers";
import * as fs from "fs";
import { PolicyService } from "./services/policy-service";
import { PolicyWorkflowService } from "./services/policy-workflow-service";
import { handleMcpRequest, type McpRequest } from "./services/mcp-request-handler";
import { deserializeContextIndex, type ContextIndex } from "./services/context-index";
import { DEFAULT_AWS_REGION } from "./types";

const DEBUG = process.env.ARCHITECT_DEBUG === "1" || process.env.MCP_DEBUG === "1";

function log(tag: string, ...args: unknown[]): void {
  if (!DEBUG) return;
  const ts = new Date().toISOString().slice(11, 23);
  process.stderr.write(`[mcp-server:${tag} ${ts}] ${args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}\n`);
}

log("init", `Starting MCP server (region: ${process.env.AWS_REGION ?? DEFAULT_AWS_REGION}, debug: ${DEBUG})`);

const region = process.env.AWS_REGION ?? DEFAULT_AWS_REGION;
const policyService = new PolicyService({
  region,
  credentials: fromIni(),
});
const workflowService = new PolicyWorkflowService(policyService);

log("init", "PolicyService + PolicyWorkflowService created");

// ── Context Index (file-based, cached in memory with fs.watch) ──

let cachedContextIndex: ContextIndex | null = null;

function loadContextIndexFromDisk(filePath: string): ContextIndex | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return deserializeContextIndex(JSON.parse(raw));
  } catch (err) {
    log("context-index", `Failed to load: ${(err as Error).message}`);
    return null;
  }
}

const contextIndexFile = process.env.CONTEXT_INDEX_FILE;
if (contextIndexFile) {
  cachedContextIndex = loadContextIndexFromDisk(contextIndexFile);
  log("context-index", `Initial load: ${cachedContextIndex ? "OK" : "not available"}`);

  try {
    fs.watch(contextIndexFile, () => {
      cachedContextIndex = loadContextIndexFromDisk(contextIndexFile);
      log("context-index", `Reloaded: ${cachedContextIndex ? "OK" : "failed"}`);
    });
    log("context-index", `Watching ${contextIndexFile} for changes`);
  } catch (err) {
    log("context-index", `fs.watch failed (will use initial load only): ${(err as Error).message}`);
  }
} else {
  log("context-index", "No CONTEXT_INDEX_FILE env var — search tools will be unavailable");
}

// ── Stdio MCP Server ──

let buffer = "";

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  processBuffer();
});
process.stdin.on("end", () => process.exit(0));

// Suppress unhandled rejection crashes — log to stderr and continue
process.on("unhandledRejection", (err) => {
  process.stderr.write(`[mcp-server] Unhandled rejection: ${err}\n`);
});

function processBuffer(): void {
  // Newline-delimited JSON (primary for Kiro CLI)
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline === -1) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handleRaw(line);
  }
}

function handleRaw(raw: string): void {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    log("parse", `Failed to parse: ${raw.slice(0, 200)}`);
    return;
  }
  if (msg.id !== undefined && msg.method) {
    handleRequest(msg);
  } else {
    log("recv", `Ignoring non-request message: ${raw.slice(0, 100)}`);
  }
}

async function handleRequest(req: McpRequest): Promise<void> {
  log("recv", `← [${req.id}] ${req.method}`);
  const response = await handleMcpRequest(req, workflowService, cachedContextIndex, log);
  respond(response.id, response.result, response.error);
}

function respond(id: string | number, result?: unknown, error?: { code: number; message: string }): void {
  const msg = error
    ? JSON.stringify({ jsonrpc: "2.0", id, error })
    : JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\n");
}
