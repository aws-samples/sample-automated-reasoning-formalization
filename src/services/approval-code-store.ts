/**
 * Shared approval code store — bridges the renderer and MCP server processes.
 *
 * The renderer writes approval codes when the user clicks "Approve" on a
 * proposal card. The MCP server validates and consumes codes before executing
 * policy-mutating tools. Codes are strictly one-time use.
 *
 * Communication uses a JSON file at a path specified by the
 * APPROVAL_CODE_FILE environment variable. An in-memory set of consumed
 * codes prevents race conditions when multiple tool calls arrive
 * concurrently — the in-memory check is authoritative and instant.
 */
import * as fs from "fs";

export interface ApprovalCodeEntry {
  code: string;
  createdAt: number;
}

/**
 * In-memory set of codes that have already been consumed in this process.
 * This is the authoritative guard against reuse — checked before the file.
 */
const consumedCodes = new Set<string>();

/**
 * Write an approval code to the shared file (renderer side).
 * Appends to existing codes rather than overwriting.
 */
export function writeApprovalCode(filePath: string, code: string): void {
  let codes: ApprovalCodeEntry[] = [];
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    codes = JSON.parse(raw);
  } catch {
    // File doesn't exist or is invalid — start fresh
  }
  codes.push({ code, createdAt: Date.now() });
  fs.writeFileSync(filePath, JSON.stringify(codes), "utf-8");
}

/**
 * Validate and consume an approval code (MCP server side).
 * Returns true if the code was valid and has been consumed.
 * Returns false if the code is missing, invalid, or already used.
 *
 * Uses an in-memory set as the primary guard against reuse, then
 * also removes the code from the shared file for consistency.
 */
export function consumeApprovalCode(filePath: string, code: string): boolean {
  // In-memory check first — prevents race conditions from concurrent calls
  if (consumedCodes.has(code)) {
    return false;
  }

  let codes: ApprovalCodeEntry[] = [];
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    codes = JSON.parse(raw);
  } catch {
    // File doesn't exist or is unreadable — no valid codes to check
    return false;
  }

  const index = codes.findIndex((entry) => entry.code === code);
  if (index === -1) return false;

  // Mark as consumed in memory FIRST — this is the authoritative check
  consumedCodes.add(code);

  // Then remove from the file for consistency
  codes.splice(index, 1);
  fs.writeFileSync(filePath, JSON.stringify(codes), "utf-8");
  return true;
}
