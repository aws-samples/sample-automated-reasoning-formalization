/**
 * Shared fidelity report parsing utilities.
 *
 * The SDK returns fidelity report assets as a discriminated union where the
 * actual report may live under a `fidelityReport` key or at the top level.
 * This helper normalizes that and validates the shape in one place.
 */
import type { FidelityReport } from "../types";

/**
 * Parse a raw fidelity report asset from the SDK into a typed FidelityReport.
 * Returns null if the asset is falsy or doesn't contain a valid fidelity report.
 */
export function parseFidelityAsset(asset: unknown): FidelityReport | null {
  if (!asset) return null;
  const raw = asset as Record<string, unknown>;
  const report = (raw.fidelityReport ?? raw) as Record<string, unknown>;
  if (report.coverageScore === undefined) return null;
  return report as unknown as FidelityReport;
}
