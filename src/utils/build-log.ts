/**
 * Utilities for parsing build log assets and extracting error messages.
 *
 * The build log asset from the API has the shape:
 *   { buildLog: { entries: BuildLogEntry[] } }
 *
 * Each entry has a status (APPLIED | FAILED), an annotation describing
 * the operation, and buildSteps containing messages with messageType
 * (INFO | WARNING | ERROR).
 */
import type { BuildLogEntry, BuildStepMessage } from "../types";

/**
 * Parse the raw build log asset into typed BuildLogEntry[].
 * Handles both `{ buildLog: { entries: [...] } }` and `{ entries: [...] }` shapes.
 */
export function parseBuildLogAsset(asset: unknown): BuildLogEntry[] {
  if (!asset || typeof asset !== "object") return [];
  const raw = asset as Record<string, unknown>;

  // The API wraps entries under buildLog.entries
  let entries: unknown[];
  const buildLog = raw.buildLog as Record<string, unknown> | undefined;
  if (buildLog && Array.isArray(buildLog.entries)) {
    entries = buildLog.entries;
  } else if (Array.isArray(raw.entries)) {
    entries = raw.entries;
  } else {
    return [];
  }

  return entries.filter(
    (e): e is BuildLogEntry =>
      e != null && typeof e === "object" && "status" in e && "buildSteps" in e,
  );
}

/**
 * Describe an annotation in a human-readable way for error context.
 * e.g. "addVariable(allCampgroundsAcceptRvs)" or "addRule"
 */
function describeAnnotation(annotation: Record<string, unknown>): string {
  for (const [key, value] of Object.entries(annotation)) {
    if (value && typeof value === "object") {
      const inner = value as Record<string, unknown>;
      const name = inner.name ?? inner.ruleId ?? inner.expression;
      return name ? `${key}(${name})` : key;
    }
    return key;
  }
  return "unknown annotation";
}

/**
 * Extract error and warning messages from build log entries.
 * Returns human-readable strings suitable for passing to the agent.
 */
export function extractBuildErrors(entries: BuildLogEntry[]): string[] {
  const errors: string[] = [];

  for (const entry of entries) {
    const label = describeAnnotation(entry.annotation);

    // Flag entries that outright failed
    if (entry.status === "FAILED") {
      const stepMessages = collectMessages(entry.buildSteps, ["ERROR", "WARNING"]);
      if (stepMessages.length > 0) {
        for (const msg of stepMessages) {
          errors.push(`[${label}] ${msg.messageType}: ${msg.message}`);
        }
      } else {
        errors.push(`[${label}] FAILED (no details provided)`);
      }
    } else {
      // Even APPLIED entries can have warnings/errors in their steps
      const stepErrors = collectMessages(entry.buildSteps, ["ERROR"]);
      for (const msg of stepErrors) {
        errors.push(`[${label}] ${msg.messageType}: ${msg.message}`);
      }
    }
  }

  return errors;
}

/** Collect messages of the given types from all build steps. */
function collectMessages(
  steps: BuildLogEntry["buildSteps"],
  types: BuildStepMessage["messageType"][],
): BuildStepMessage[] {
  const typeSet = new Set(types);
  return (steps ?? []).flatMap((step) =>
    (step.messages ?? []).filter((m) => typeSet.has(m.messageType)),
  );
}
