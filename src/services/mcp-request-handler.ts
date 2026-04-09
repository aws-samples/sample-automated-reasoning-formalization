/**
 * Pure request→response handler for MCP protocol messages.
 *
 * Extracted from mcp-server-entry.ts so the request handling logic
 * can be tested directly without spawning a subprocess or wiring
 * up stdin/stdout.
 */
import type { PolicyWorkflowService } from './policy-workflow-service';
import { POLICY_TOOLS, SEARCH_TOOLS, dispatchToolCall } from './policy-mcp-server';
import type { ContextIndex } from './context-index';

export interface McpRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

export interface McpResponse {
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Handle a single MCP JSON-RPC request and return the response.
 *
 * This is a pure async function: no I/O, no stdin/stdout, no process globals.
 * The caller is responsible for serialization and transport.
 */
export async function handleMcpRequest(
  req: McpRequest,
  workflowService: PolicyWorkflowService,
  contextIndex: ContextIndex | null,
  logger?: (tag: string, ...args: unknown[]) => void,
): Promise<McpResponse> {
  const log = logger ?? (() => {});
  const start = Date.now();

  switch (req.method) {
    case 'initialize':
      log('send', `→ [${req.id}] initialize OK (${Date.now() - start}ms)`);
      return {
        id: req.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'architect-policy-tools', version: '0.1.0' },
        },
      };

    case 'notifications/initialized':
      // Note: per JSON-RPC 2.0, notifications expect no response. We respond here
      // because the Kiro CLI sends this with an id and expects an ack.
      log('send', `→ [${req.id}] notifications/initialized OK`);
      return { id: req.id, result: {} };

    case 'tools/list': {
      const allTools = [...POLICY_TOOLS, ...SEARCH_TOOLS];
      log('send', `→ [${req.id}] tools/list — ${allTools.length} tools`);
      return { id: req.id, result: { tools: allTools } };
    }

    case 'tools/call': {
      const params = req.params as Record<string, unknown> | undefined;
      const name = params?.name;
      if (typeof name !== 'string' || name.length === 0) {
        return {
          id: req.id,
          error: { code: -32602, message: 'Missing or invalid tool name in params' },
        };
      }
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      log('tool', `Calling ${name} with args: ${JSON.stringify(args).slice(0, 500)}`);
      try {
        const result = await dispatchToolCall(workflowService, contextIndex, name, args, log);
        const elapsed = Date.now() - start;
        const isErr = result.isError ? ' (ERROR)' : '';
        const preview = result.content?.[0]?.text?.slice(0, 300) ?? '';
        log('tool', `${name} completed in ${elapsed}ms${isErr}: ${preview}`);
        return { id: req.id, result };
      } catch (err) {
        const elapsed = Date.now() - start;
        log('tool', `${name} THREW after ${elapsed}ms: ${(err as Error).message}`);
        return {
          id: req.id,
          result: {
            content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
            isError: true,
          },
        };
      }
    }

    default:
      log('recv', `Unknown method: ${req.method}`);
      return {
        id: req.id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      };
  }
}
