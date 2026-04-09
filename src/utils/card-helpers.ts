/**
 * Shared utility functions for card rendering and actions.
 * Extracted from the old imperative card renderers so they can
 * be used by both the React card components and the legacy
 * rewireCardActions history restore path.
 */

/**
 * Generate a unique approval code for proposal card approval.
 * The code is written via IPC and validated by the MCP server.
 */
export function generateApprovalCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const segments = [8, 4, 4, 4, 12];
  return segments
    .map((len) => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join(""))
    .join("-");
}


