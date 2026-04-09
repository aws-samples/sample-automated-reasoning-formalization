#!/usr/bin/env npx tsx
/**
 * Standalone report generator — produces an HTML report from a benchmark JSON file.
 *
 * Usage:
 *   npm run benchmark:generate-report -- --input path/to/benchmark.json
 *   npm run benchmark:generate-report -- --input path/to/benchmark.json --output-dir ./my-reports
 */
import * as fs from "fs";
import * as path from "path";
import { generateReport } from "./report-generator";
import type { BenchmarkReport } from "./types";

const REQUIRED_KEYS: (keyof BenchmarkReport)[] = [
  "runId", "startTime", "endTime", "session", "deterministicEval", "config",
];

function parseArgs(): { inputPath: string; outputDir: string } {
  const args = process.argv.slice(2);
  let inputPath = "";
  let outputDir = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input" && args[i + 1]) {
      inputPath = args[++i];
    } else if (args[i] === "--output-dir" && args[i + 1]) {
      outputDir = args[++i];
    }
  }

  if (!inputPath) {
    console.error("Usage: npx tsx generate-report-cli.ts --input <path/to/benchmark.json> [--output-dir <dir>]");
    process.exit(1);
  }

  if (!outputDir) {
    outputDir = path.join(__dirname, "..", "reports");
  }

  return { inputPath: path.resolve(inputPath), outputDir: path.resolve(outputDir) };
}

function validateReport(data: unknown): data is BenchmarkReport {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return REQUIRED_KEYS.every(key => key in obj);
}

function main(): void {
  const { inputPath, outputDir } = parseArgs();

  if (!fs.existsSync(inputPath)) {
    console.error(`Error: file not found: ${inputPath}`);
    process.exit(1);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(inputPath, "utf-8"));
  } catch (err) {
    console.error(`Error: failed to parse JSON: ${(err as Error).message}`);
    process.exit(1);
  }

  if (!validateReport(raw)) {
    const obj = raw as Record<string, unknown>;
    const missing = REQUIRED_KEYS.filter(key => !(key in obj));
    console.error(`Error: input file is not a valid BenchmarkReport. Missing keys: ${missing.join(", ")}`);
    process.exit(1);
  }

  const htmlPath = generateReport(raw, outputDir);
  console.log(`HTML report generated: ${htmlPath}`);
}

main();
