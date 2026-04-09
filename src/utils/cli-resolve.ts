/**
 * Shared CLI resolution utilities.
 *
 * Used by both integration tests (acp-connection.integration.test.ts)
 * and E2E tests (src/e2e/) to locate the kiro-cli binary.
 */
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execFileSync } from "child_process";

const isWindows = process.platform === "win32";

/** Binary name for the current platform. */
export const cliBinaryName = isWindows ? "kiro-cli.exe" : "kiro-cli";

/** Build candidate paths for the kiro-cli binary given a home directory. */
export function buildCliCandidates(homeDir: string): string[] {
  // homeDir comes from os.homedir(); all paths are well-known install locations
  return isWindows
    ? [
        join(homeDir, "AppData", "Local", "kiro-cli", cliBinaryName), // nosemgrep: path-join-resolve-traversal
        join(process.env.PROGRAMFILES ?? "C:\\Program Files", "kiro-cli", cliBinaryName),
      ]
    : [
        join(homeDir, ".local", "bin", cliBinaryName), // nosemgrep: path-join-resolve-traversal
        "/usr/local/bin/kiro-cli",
      ];
}

/** Resolve kiro-cli path, checking common install locations. */
export function resolveKiroCliPath(): string {
  for (const p of buildCliCandidates(homedir())) {
    if (existsSync(p)) return p;
  }
  return cliBinaryName;
}

/** Check if a binary is reachable via PATH. */
export function canResolve(bin: string): boolean {
  try {
    const cmd = isWindows ? "where" : "which";
    execFileSync(cmd, [bin], { stdio: "pipe" });
    return true;
  } catch {
    // Binary not found on PATH — expected when checking availability
    return false;
  }
}
