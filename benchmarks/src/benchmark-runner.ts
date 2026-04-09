#!/usr/bin/env npx tsx
/**
 * Benchmark runner — orchestrates the full benchmark lifecycle.
 *
 * Usage:
 *   npm run benchmark
 *   BENCHMARK_MAX_ITERATIONS=10 npm run benchmark
 *   BENCHMARK_SKIP_JUDGE=1 npm run benchmark
 *
 * Custom fixtures:
 *   npm run benchmark -- --policy-definition path/to/def.json --document path/to/doc.md --tests path/to/tests.json
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fromIni } from "@aws-sdk/credential-providers";
import { PolicyService } from "../../src/services/policy-service";
import { resolveKiroCliPath } from "../../src/utils/cli-resolve";
import { createBenchmarkPolicy } from "./policy-harness";
import { runAgentLoop } from "./agent-loop";
import { computeDeterministicEvaluation, evaluateWithJudge } from "./evaluation";
import { generateReport } from "./report-generator";
import type { BenchmarkFixture, BenchmarkConfig, BenchmarkReport } from "./types";

// ── Configuration ──

const config: BenchmarkConfig = {
  maxIterations: parseInt(process.env.BENCHMARK_MAX_ITERATIONS ?? "0", 10), // 0 = auto (numTests × 2, cap 100)
  perTurnTimeoutMs: 600_000,
  globalTimeoutMs: 3_600_000,
  skipJudge: process.env.BENCHMARK_SKIP_JUDGE === "1",
  region: process.env.AWS_REGION ?? "us-west-2",
};

const reportDir = process.env.BENCHMARK_REPORT_DIR ?? path.join(__dirname, "..", "reports");

interface FixtureOverrides {
  readonly definitionPath: string;
  readonly documentPath: string;
  readonly testsPath: string;
}

function parseCliArgs(): { fixtureOverrides: FixtureOverrides | null } {
  const args = process.argv.slice(2);
  let definitionPath = "";
  let documentPath = "";
  let testsPath = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--policy-definition" && args[i + 1]) {
      definitionPath = args[++i];
    } else if (args[i] === "--document" && args[i + 1]) {
      documentPath = args[++i];
    } else if (args[i] === "--tests" && args[i + 1]) {
      testsPath = args[++i];
    }
  }

  const anyProvided = definitionPath || documentPath || testsPath;
  if (!anyProvided) return { fixtureOverrides: null };

  const allProvided = definitionPath && documentPath && testsPath;
  if (!allProvided) {
    const missing: string[] = [];
    if (!definitionPath) missing.push("--policy-definition");
    if (!documentPath) missing.push("--document");
    if (!testsPath) missing.push("--tests");
    console.error(`Error: when using custom fixtures, all three arguments are required. Missing: ${missing.join(", ")}`);
    process.exit(1);
  }

  return {
    fixtureOverrides: {
      definitionPath: path.resolve(definitionPath),
      documentPath: path.resolve(documentPath),
      testsPath: path.resolve(testsPath),
    },
  };
}

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.error(`[benchmark ${ts}] ${msg}`);
}

function loadFixture(overrides?: FixtureOverrides | null): BenchmarkFixture {
  if (overrides) {
    for (const [label, filePath] of Object.entries(overrides)) {
      if (!fs.existsSync(filePath)) {
        console.error(`Error: ${label} file not found: ${filePath}`);
        process.exit(1);
      }
    }
    let defRaw: Record<string, unknown>;
    try {
      defRaw = JSON.parse(fs.readFileSync(overrides.definitionPath, "utf-8"));
    } catch (err) {
      console.error(`Error: failed to parse policy definition JSON: ${(err as Error).message}`);
      process.exit(1);
    }
    if (!defRaw.policyDefinition) {
      console.error('Error: definition file must contain a "policyDefinition" key.');
      process.exit(1);
    }
    const docText = fs.readFileSync(overrides.documentPath, "utf-8");
    let testsRaw: Record<string, unknown>;
    try {
      testsRaw = JSON.parse(fs.readFileSync(overrides.testsPath, "utf-8"));
    } catch (err) {
      console.error(`Error: failed to parse tests JSON: ${(err as Error).message}`);
      process.exit(1);
    }
    if (!Array.isArray(testsRaw.tests)) {
      console.error('Error: tests file must contain a "tests" array.');
      process.exit(1);
    }
    return {
      policyDefinition: defRaw.policyDefinition as Record<string, unknown>,
      sourceDocumentText: docText,
      tests: testsRaw.tests,
    };
  }

  const fixtureDir = path.join(__dirname, "..", "fixtures");
  const defRaw = JSON.parse(fs.readFileSync(path.join(fixtureDir, "expense-policy-definition.json"), "utf-8"));
  const docText = fs.readFileSync(path.join(fixtureDir, "expense-policy-document.md"), "utf-8");
  const testsRaw = JSON.parse(fs.readFileSync(path.join(fixtureDir, "expense-policy-tests.json"), "utf-8"));
  return { policyDefinition: defRaw.policyDefinition, sourceDocumentText: docText, tests: testsRaw.tests };
}

function resolveMcpServerPath(): string {
  const webpackPath = path.join(process.cwd(), ".webpack", "main", "mcp-server.js");
  if (fs.existsSync(webpackPath)) return webpackPath;
  const srcPath = path.join(process.cwd(), "src", "mcp-server-entry.ts");
  if (fs.existsSync(srcPath)) return srcPath;
  throw new Error("Cannot find MCP server. Run 'npm start' once to generate .webpack/main/mcp-server.js");
}

async function main(): Promise<void> {
  const { fixtureOverrides } = parseCliArgs();

  log("Starting agent benchmark…");
  log(`Config: maxIterations=${config.maxIterations}, skipJudge=${config.skipJudge}, region=${config.region}`);
  if (fixtureOverrides) {
    log(`Custom fixtures: definition=${fixtureOverrides.definitionPath}, document=${fixtureOverrides.documentPath}, tests=${fixtureOverrides.testsPath}`);
  }

  const startTime = new Date().toISOString();
  const fixture = loadFixture(fixtureOverrides);
  const fixtureName = fixtureOverrides
    ? path.basename(fixtureOverrides.definitionPath, path.extname(fixtureOverrides.definitionPath))
    : "expense-policy";
  log(`Loaded fixture: ${fixture.tests.length} tests, ${(fixture.policyDefinition as any).rules?.length ?? 0} rules`);

  const policyService = new PolicyService({ region: config.region, credentials: fromIni() });
  const mcpServerPath = resolveMcpServerPath();
  const approvalCodeFilePath = path.join(os.tmpdir(), `benchmark-approval-${Date.now()}.json`);
  fs.writeFileSync(approvalCodeFilePath, "[]");

  // Calculate max iterations: numTests * 2, capped at 100, overridable via env
  const autoMaxIterations = Math.min(fixture.tests.length * 2, 100);
  const maxIterations = config.maxIterations > 0
    ? Math.min(config.maxIterations, 100)
    : autoMaxIterations;
  log(`Max iterations: ${maxIterations} (${fixture.tests.length} tests × 2 = ${fixture.tests.length * 2}, cap 100)`);

  const mcpServerConfig = {
    name: "architect-policy-tools",
    command: "node",
    args: [mcpServerPath],
    env: { AWS_REGION: config.region, APPROVAL_CODE_FILE: approvalCodeFilePath },
  };

  log(`CLI path: ${resolveKiroCliPath()}`);
  log(`MCP server: ${mcpServerPath}`);
  log(`Approval code file: ${approvalCodeFilePath}`);

  const abortController = new AbortController();
  const globalTimeout = setTimeout(() => {
    log("Global timeout reached — aborting.");
    abortController.abort();
  }, config.globalTimeoutMs);

  const timing = { setupMs: 0, baselineMs: 0, agentLoopMs: 0, judgeEvaluationMs: 0, teardownMs: 0, totalMs: 0 };
  let harness: Awaited<ReturnType<typeof createBenchmarkPolicy>> | null = null;
  let policyCreatedAt = "";
  let policyDeletedAt = "";

  const emergencyCleanup = () => {
    log("Signal received — cleaning up…");
    try { fs.unlinkSync(approvalCodeFilePath); } catch { /* safe */ }
    if (harness) {
      harness.cleanup()
        .catch((e) => log(`Cleanup error: ${(e as Error).message}`))
        .finally(() => process.exit(1));
    } else {
      process.exit(1);
    }
  };
  process.on("SIGINT", emergencyCleanup);
  process.on("SIGTERM", emergencyCleanup);

  try {
    // ── 1. SETUP ──
    const setupStart = Date.now();
    harness = await createBenchmarkPolicy(policyService, fixture, log);
    policyCreatedAt = new Date().toISOString();
    timing.setupMs = Date.now() - setupStart;
    log(`Setup complete in ${Math.round(timing.setupMs / 1000)}s.`);

    // ── 2. AGENT REPAIR LOOP ──
    const loopStart = Date.now();
    const session = await runAgentLoop(
      policyService, harness, fixture,
      { maxIterations, approvalCodeFilePath, mcpServerConfig, log, abortSignal: abortController.signal },
    );
    timing.agentLoopMs = Date.now() - loopStart;
    log(`Agent loop complete in ${Math.round(timing.agentLoopMs / 1000)}s. Converged: ${session.converged}`);

    // ── 3. EVALUATION ──
    const deterministicEval = computeDeterministicEvaluation(session);
    let judgeEval = null;
    if (!config.skipJudge) {
      const judgeStart = Date.now();
      judgeEval = await evaluateWithJudge(session, fixture.sourceDocumentText, fixture.policyDefinition as any, log, config.region);
      timing.judgeEvaluationMs = Date.now() - judgeStart;
    }

    // ── 4. TEARDOWN ──
    const teardownStart = Date.now();
    const reportPolicyArn = harness.policyArn;
    await harness.cleanup();
    policyDeletedAt = new Date().toISOString();
    try { fs.unlinkSync(approvalCodeFilePath); } catch { /* safe */ }
    timing.teardownMs = Date.now() - teardownStart;
    harness = null;

    const endTime = new Date().toISOString();
    timing.totalMs = Date.now() - new Date(startTime).getTime();

    // ── 5. REPORT ──
    let kiroVersion = "unknown";
    try {
      const { execSync } = await import("child_process");
      kiroVersion = execSync(`${resolveKiroCliPath()} --version 2>&1`, { timeout: 5000 }).toString().trim();
    } catch { /* safe */ }

    const report: BenchmarkReport = {
      runId: `benchmark-${Date.now()}`,
      startTime,
      endTime,
      fixture: fixtureName,
      config,
      environment: { kiroCliVersion: kiroVersion, nodeVersion: process.version, platform: `${process.platform}-${process.arch}` },
      ephemeralPolicy: { policyArn: reportPolicyArn, createdAt: policyCreatedAt, deletedAt: policyDeletedAt },
      timing,
      session,
      deterministicEval,
      judgeEval,
    };

    const htmlPath = generateReport(report, reportDir);
    log(`\nReport written to: ${htmlPath}`);
    log(`\n═══ RESULTS ═══`);
    log(`Tests passing: ${session.finalPassCount} / ${session.totalTests}`);
    log(`Converged: ${session.converged} (${deterministicEval.iterationsToConverge} iterations)`);
    log(`Total time: ${Math.round(timing.totalMs / 1000)}s`);
    log(`Tool calls: ${deterministicEval.totalToolCalls}`);
    if (judgeEval) log(`Judge score: ${judgeEval.overallScore.toFixed(1)} / 5`);

  } catch (err) {
    log(`FATAL: ${(err as Error).message}`);
    console.error(err);
    process.exitCode = 1;
  } finally {
    clearTimeout(globalTimeout);
    process.removeListener("SIGINT", emergencyCleanup);
    process.removeListener("SIGTERM", emergencyCleanup);
    if (harness) {
      try { await harness.cleanup(); } catch (e) { log(`Cleanup error: ${(e as Error).message}`); }
    }
    try { fs.unlinkSync(approvalCodeFilePath); } catch { /* safe */ }
  }
}

main().then(() => {
  process.exit(process.exitCode ?? 0);
}).catch(() => {
  process.exit(process.exitCode ?? 1);
});
