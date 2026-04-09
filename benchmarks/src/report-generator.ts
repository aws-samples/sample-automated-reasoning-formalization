/**
 * Report generator — produces a self-contained HTML benchmark report.
 *
 * The output matches the layout in docs/example-benchmark-report.html:
 * summary cards, Chart.js charts, iteration log, per-test heatmap,
 * judge assessments, and collapsible raw data sections.
 */
import * as fs from "fs";
import * as path from "path";
import type { BenchmarkReport } from "./types";
import type { ToolCallObservation } from "./types";

// ── Context retrieval extraction ──

/** Set of MCP tool names that retrieve policy/document content. */
const SEARCH_TOOL_NAMES = new Set([
  "search_document", "get_document_section", "search_rules",
  "search_variables", "get_section_rules", "get_rule_details",
  "get_variable_details", "find_related_content",
]);

interface ContextRetrievalEntry {
  toolName: string;
  /** The search query or identifier that was requested */
  query: string;
  /** Summary of what was returned — section IDs, rule IDs, variable names, etc. */
  retrievedItems: string[];
  resultCount: number;
}

function safeParseResult(result: unknown): unknown {
  if (typeof result === "string") {
    try { return JSON.parse(result); } catch { return result; }
  }
  // MCP tool results come as [{ type: "text", text: "..." }] arrays
  if (Array.isArray(result) && result.length > 0 && result[0]?.text) {
    try { return JSON.parse(result[0].text); } catch { return result[0].text; }
  }
  return result;
}

function parseRetrievalResult(toolName: string, input: unknown, result: unknown): ContextRetrievalEntry {
  const inp = (input ?? {}) as Record<string, unknown>;
  const parsed = safeParseResult(result);
  const data = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;

  switch (toolName) {
    case "search_document": {
      const results = Array.isArray(data.results) ? data.results : [];
      return {
        toolName,
        query: String(inp.query ?? ""),
        retrievedItems: results.map((r: any) => `§${r.sectionId ?? "?"}: ${String(r.title ?? r.sectionTitle ?? "").slice(0, 80)}`),
        resultCount: results.length,
      };
    }
    case "get_document_section": {
      const title = data.title ?? data.sectionId ?? inp.sectionId ?? "?";
      return {
        toolName,
        query: String(inp.sectionId ?? ""),
        retrievedItems: [`§${data.sectionId ?? inp.sectionId}: ${String(title).slice(0, 80)}`],
        resultCount: 1,
      };
    }
    case "search_rules": {
      const results = Array.isArray(data.results) ? data.results : [];
      return {
        toolName,
        query: String(inp.query ?? ""),
        retrievedItems: results.map((r: any) => String(r.ruleId ?? r.id ?? "?").slice(0, 60)),
        resultCount: results.length,
      };
    }
    case "search_variables": {
      const results = Array.isArray(data.results) ? data.results : [];
      return {
        toolName,
        query: String(inp.query ?? ""),
        retrievedItems: results.map((r: any) => String(r.name ?? r.variableName ?? "?").slice(0, 60)),
        resultCount: results.length,
      };
    }
    case "get_section_rules": {
      const rules = Array.isArray(data.rules) ? data.rules : [];
      const variables = Array.isArray(data.variables) ? data.variables : [];
      return {
        toolName,
        query: String(inp.sectionId ?? ""),
        retrievedItems: [
          ...rules.map((r: any) => `rule: ${String(r.ruleId ?? r.id ?? "?").slice(0, 60)}`),
          ...variables.map((v: any) => `var: ${String(v.name ?? "?").slice(0, 60)}`),
        ],
        resultCount: rules.length + variables.length,
      };
    }
    case "get_rule_details": {
      const results = Array.isArray(data.results) ? data.results : [];
      return {
        toolName,
        query: Array.isArray(inp.ruleIds) ? inp.ruleIds.join(", ") : String(inp.ruleIds ?? ""),
        retrievedItems: results.map((r: any) => String(r.ruleId ?? r.id ?? "?").slice(0, 60)),
        resultCount: results.length,
      };
    }
    case "get_variable_details": {
      const results = Array.isArray(data.results) ? data.results : [];
      return {
        toolName,
        query: Array.isArray(inp.variableNames) ? inp.variableNames.join(", ") : String(inp.variableNames ?? ""),
        retrievedItems: results.map((r: any) => String(r.name ?? r.variableName ?? "?").slice(0, 60)),
        resultCount: results.length,
      };
    }
    case "find_related_content": {
      const items = Array.isArray(data.items) ? data.items : [];
      const queryParts: string[] = [];
      if (inp.ruleId) queryParts.push(`rule:${inp.ruleId}`);
      if (inp.variableName) queryParts.push(`var:${inp.variableName}`);
      return {
        toolName,
        query: queryParts.join(", ") || "?",
        retrievedItems: items.map((item: any) => {
          const type = item.type ?? "?";
          const id = item.ruleId ?? item.variableName ?? item.sectionId ?? item.id ?? "?";
          return `${type}: ${String(id).slice(0, 60)}`;
        }),
        resultCount: items.length,
      };
    }
    default:
      return { toolName, query: "?", retrievedItems: [], resultCount: 0 };
  }
}

function extractContextRetrievals(toolCalls: ToolCallObservation[]): ContextRetrievalEntry[] {
  return toolCalls
    .filter((tc) => SEARCH_TOOL_NAMES.has(tc.title) && tc.result != null && tc.resultStatus !== "error")
    .map((tc) => parseRetrievalResult(tc.title, tc.input, tc.result));
}

export function generateReport(report: BenchmarkReport, outputDir: string): string {
  const timestamp = report.startTime.replace(/[:.]/g, "-");
  const resolvedDir = path.resolve(outputDir); // nosemgrep: path-join-resolve-traversal
  fs.mkdirSync(resolvedDir, { recursive: true });

  // nosemgrep: path-join-resolve-traversal — timestamp is derived from report.startTime (ISO date), resolvedDir is caller-controlled benchmark output
  const jsonPath = path.join(resolvedDir, `benchmark-${timestamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  // nosemgrep: path-join-resolve-traversal — same as above
  const htmlPath = path.join(resolvedDir, `benchmark-${timestamp}.html`);
  const html = buildHtml(report);
  fs.writeFileSync(htmlPath, html);

  return htmlPath;
}

function fmt(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const CSS = `<style>
  :root { --pass:#22c55e;--fail:#ef4444;--warn:#f59e0b;--bg:#0f172a;--surface:#1e293b;--surface2:#334155;--text:#e2e8f0;--text-muted:#94a3b8;--border:#475569;--accent:#3b82f6; }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);line-height:1.6;padding:2rem}
  h1{font-size:1.5rem;margin-bottom:.25rem} h2{font-size:1.15rem;margin:2rem 0 1rem;border-bottom:1px solid var(--border);padding-bottom:.5rem}
  h3{font-size:1rem;margin:1.5rem 0 .75rem;color:var(--text-muted)} .subtitle{color:var(--text-muted);font-size:.85rem;margin-bottom:1.5rem}
  .summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:1rem;margin-bottom:2rem}
  .summary-card{background:var(--surface);border-radius:8px;padding:1rem 1.25rem;border:1px solid var(--border)}
  .summary-card .label{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:.25rem}
  .summary-card .value{font-size:1.75rem;font-weight:700} .summary-card .detail{font-size:.8rem;color:var(--text-muted);margin-top:.25rem}
  .badge-pass{color:var(--pass)} .badge-fail{color:var(--fail)} .badge-warn{color:var(--warn)}
  .chart-grid{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;margin-bottom:2rem}
  .chart-container{background:var(--surface);border-radius:8px;padding:1.25rem;border:1px solid var(--border)}
  .chart-container.full-width{grid-column:1/-1} .chart-container h3{margin-top:0} canvas{max-height:280px}
  table{width:100%;border-collapse:collapse;font-size:.85rem;margin-bottom:1.5rem}
  th,td{padding:.6rem .75rem;text-align:left;border-bottom:1px solid var(--border)}
  th{background:var(--surface2);font-weight:600;font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted);position:sticky;top:0}
  td{background:var(--surface)} tr:hover td{background:var(--surface2)}
  .cell-pass{background:#166534;color:#bbf7d0;text-align:center;font-weight:600}
  .cell-fail{background:#991b1b;color:#fecaca;text-align:center;font-weight:600}
  .cell-na{background:var(--surface2);color:var(--text-muted);text-align:center}
  .score-good{color:var(--pass);font-weight:600} .score-warn{color:var(--warn);font-weight:600} .score-bad{color:var(--fail);font-weight:600}
  details{background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:1rem}
  summary{padding:.75rem 1rem;cursor:pointer;font-weight:600;font-size:.85rem;color:var(--text-muted)} summary:hover{color:var(--text)}
  details>div{padding:0 1rem 1rem}
  pre{background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:.75rem;overflow-x:auto;font-size:.78rem;line-height:1.5;white-space:pre-wrap;word-break:break-word}
  code{font-family:'SF Mono','Fira Code',monospace}
</style>`;

function buildHtml(r: BenchmarkReport): string {
  const { session: s, deterministicEval: d, judgeEval: j } = r;
  const passColor = s.finalPassCount === s.totalTests ? "badge-pass" : s.finalPassCount > 0 ? "badge-warn" : "badge-fail";
  const judgeColor = (j?.overallScore ?? 0) >= 4 ? "badge-pass" : (j?.overallScore ?? 0) >= 2.5 ? "badge-warn" : "badge-fail";

  // Tool call breakdown
  const toolBreakdown = new Map<string, number>();
  for (const iter of s.iterations) {
    for (const tc of iter.toolCalls) {
      const name = tc.title || "unknown";
      toolBreakdown.set(name, (toolBreakdown.get(name) ?? 0) + 1);
    }
  }
  const toolDetail = [...toolBreakdown.entries()].map(([k, v]) => `${v} ${k}`).join(" · ") || "none";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Agent Benchmark Report — ${esc(r.startTime)}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js" integrity="sha384-vsrfeLOOY6KuIYKDlmVH5UiBmgIdB1oEf7p01YgWHuqmOHfZr374+odEv96n9tNC" crossorigin="anonymous"></script>
${CSS}
</head>
<body>

<h1>Agent Benchmark Report</h1>
<div class="subtitle">
  Run: ${esc(r.startTime)} &nbsp;·&nbsp; Fixture: ${esc(r.fixture)} &nbsp;·&nbsp; Max iterations: ${r.config.maxIterations} &nbsp;·&nbsp; Region: ${esc(r.config.region)}
</div>

${buildSummaryCards(s, d, j, passColor, judgeColor, toolDetail)}
${buildChartSection(s, d)}
${buildIterationLog(s)}
${buildContextRetrievals(s)}
${buildPerTestHeatmap(s, d)}
${buildJudgeTable(j)}
${buildRawData(s, r)}

${buildChartScript(s, d)}
</body>
</html>`;
}

// ── Summary Cards ──

function buildSummaryCards(
  s: BenchmarkReport["session"],
  d: BenchmarkReport["deterministicEval"],
  j: BenchmarkReport["judgeEval"],
  passColor: string,
  judgeColor: string,
  toolDetail: string,
): string {
  return `
<div class="summary-grid">
  <div class="summary-card">
    <div class="label">Tests Passing</div>
    <div class="value ${passColor}">${s.finalPassCount} / ${s.totalTests}</div>
    <div class="detail">${s.converged ? "All tests fixed" : `${s.finalFailCount} still failing`}</div>
  </div>
  <div class="summary-card">
    <div class="label">Judge Score</div>
    <div class="value ${judgeColor}">${j ? `${j.overallScore.toFixed(1)} / 5` : "N/A"}</div>
    <div class="detail">${j ? `${j.changes.filter(c => c.generalizability === "generalizable").length} generalizable · ${j.changes.filter(c => c.generalizability === "likely_overfitting").length} overfitting` : "Skipped"}</div>
  </div>
  <div class="summary-card">
    <div class="label">Iterations</div>
    <div class="value">${d.iterationsToConverge}</div>
    <div class="detail">of ${s.iterations.length > 0 ? s.iterations[s.iterations.length - 1].iteration : 0} run</div>
  </div>
  <div class="summary-card">
    <div class="label">Total Time</div>
    <div class="value">${fmt(d.totalLatencyMs)}</div>
    <div class="detail">${d.perIterationLatencyMs.map((ms, i) => `Iter ${i}: ${fmt(ms)}`).join(" · ")}</div>
  </div>
  <div class="summary-card">
    <div class="label">Tool Calls</div>
    <div class="value">${d.totalToolCalls}</div>
    <div class="detail">${toolDetail}</div>
  </div>
  <div class="summary-card">
    <div class="label">Build Errors</div>
    <div class="value ${d.totalBuildErrors === 0 ? "badge-pass" : "badge-fail"}">${d.totalBuildErrors}</div>
    <div class="detail">${d.totalBuildErrors === 0 ? "No failed annotations" : `${d.totalBuildErrors} iteration(s) with errors`}</div>
  </div>
  <div class="summary-card">
    <div class="label">No-Op Iterations</div>
    <div class="value">${d.noOpIterations}</div>
    <div class="detail">${d.noOpIterations === 0 ? "Agent proposed every iteration" : `${d.noOpIterations} iteration(s) without proposals`}</div>
  </div>
</div>`;
}

// ── Charts ──

function buildChartSection(
  _s: BenchmarkReport["session"],
  _d: BenchmarkReport["deterministicEval"],
): string {
  return `
<h2>Convergence &amp; Performance</h2>
<div class="chart-grid">
  <div class="chart-container">
    <h3>Tests Passing Over Time</h3>
    <canvas id="testsPassingChart"></canvas>
  </div>
  <div class="chart-container">
    <h3>Per-Iteration Latency</h3>
    <canvas id="latencyChart"></canvas>
  </div>
  <div class="chart-container full-width">
    <h3>Per-Test Convergence (iteration when test first passed)</h3>
    <canvas id="convergenceChart"></canvas>
  </div>
</div>`;
}

// ── Iteration Log ──

function buildIterationLog(s: BenchmarkReport["session"]): string {
  const rows = s.iterations.map(iter => {
    const toolNames = iter.toolCalls.map(tc => esc(tc.title || "unknown")).join(", ") || "—";
    const proposalCol = iter.iteration === 0
      ? '<td class="cell-na">—</td>'
      : iter.proposalEmitted
        ? `<td>✅ ${esc(iter.proposalCards.map(p => p.title).join("; "))}</td>`
        : '<td class="cell-fail">No proposal</td>';
    const promptSummary = iter.iteration === 0
      ? "<em>Baseline — no agent prompt</em>"
      : `<strong>${esc(iter.targetFixtureTestId ?? "unknown")}</strong>: ${esc(iter.prompt.slice(0, 150))}${iter.prompt.length > 150 ? "…" : ""}`;

    return `<tr>
      <td>${iter.iteration}</td>
      <td>${promptSummary}</td>
      ${proposalCol}
      <td>${toolNames}</td>
      <td>${iter.conversationTrace?.length ?? 0}</td>
      <td>${iter.passingTests} / ${iter.testResults.length}</td>
      <td>${iter.failingTests} / ${iter.testResults.length}</td>
      <td>${fmt(iter.latencyMs)}</td>
    </tr>`;
  }).join("\n");

  return `
<h2>Iteration Log</h2>
<table>
  <thead>
    <tr><th>#</th><th>Target Test</th><th>Proposal</th><th>Tool Calls</th><th>Turns</th><th>Passing</th><th>Failing</th><th>Latency</th></tr>
  </thead>
  <tbody>${rows}</tbody>
</table>`;
}

// ── Context Retrievals ──

function buildContextRetrievals(s: BenchmarkReport["session"]): string {
  const iterationsWithRetrievals = s.iterations
    .filter(iter => iter.iteration > 0)
    .map(iter => ({
      iteration: iter.iteration,
      target: iter.targetFixtureTestId ?? "unknown",
      retrievals: extractContextRetrievals(iter.toolCalls),
    }))
    .filter(iter => iter.retrievals.length > 0);

  if (iterationsWithRetrievals.length === 0) {
    return `
<h2>Context Retrievals</h2>
<p style="color:var(--text-muted);font-size:0.85rem">No search/describe tool calls observed. The agent may have operated in full-context mode.</p>`;
  }

  const sections = iterationsWithRetrievals.map(iter => {
    const rows = iter.retrievals.map(r => {
      const items = r.retrievedItems.length > 0
        ? r.retrievedItems.map(i => esc(i)).join("<br>")
        : "<span style=\"color:var(--text-muted)\">none</span>";
      return `<tr>
        <td><code>${esc(r.toolName)}</code></td>
        <td><code>${esc(r.query.slice(0, 120))}${r.query.length > 120 ? "…" : ""}</code></td>
        <td>${items}</td>
        <td>${r.resultCount}</td>
      </tr>`;
    }).join("\n");

    return `<details open>
  <summary>Iteration ${iter.iteration} — ${esc(iter.target)} (${iter.retrievals.length} retrieval${iter.retrievals.length === 1 ? "" : "s"})</summary>
  <div>
    <table>
      <thead><tr><th>Tool</th><th>Query</th><th>Retrieved Items</th><th>#</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</details>`;
  }).join("\n");

  // Aggregate stats
  const allRetrievals = iterationsWithRetrievals.flatMap(i => i.retrievals);
  const toolCounts = new Map<string, number>();
  for (const r of allRetrievals) {
    toolCounts.set(r.toolName, (toolCounts.get(r.toolName) ?? 0) + 1);
  }
  const totalItems = allRetrievals.reduce((sum, r) => sum + r.resultCount, 0);
  const toolSummary = [...toolCounts.entries()].map(([k, v]) => `${v}× ${k}`).join(" · ");

  return `
<h2>Context Retrievals</h2>
<p style="color:var(--text-muted);font-size:0.85rem;margin-bottom:1rem">
  Which portions of the source document and policy definition the agent retrieved via MCP search/describe tools.
  ${allRetrievals.length} call${allRetrievals.length === 1 ? "" : "s"} returned ${totalItems} item${totalItems === 1 ? "" : "s"} total.
  Breakdown: ${toolSummary}.
</p>
${sections}`;
}

// ── Per-Test Heatmap ──

function buildPerTestHeatmap(
  s: BenchmarkReport["session"],
  d: BenchmarkReport["deterministicEval"],
): string {
  if (s.iterations.length === 0) return "";

  const iterHeaders = s.iterations.map(i =>
    i.iteration === 0 ? "<th>Baseline</th>" : `<th>Iter ${i.iteration}</th>`
  ).join("");

  const testIds = s.iterations[0].testResults.map(r => r.testCaseId);
  const rows = testIds.map(tcId => {
    const first = s.iterations[0].testResults.find(r => r.testCaseId === tcId);
    const fixtureId = first?.fixtureTestId ?? "unknown";
    const guard = esc((first?.guardContent ?? "").slice(0, 60));
    const expected = first?.expectedResult ?? "?";

    // Find target deficiency from convergence data
    const conv = d.perTestConvergence.find(c => c.testCaseId === tcId);
    const firstPassed = conv?.firstPassedAtIteration;
    const firstPassedLabel = firstPassed === null ? "Never" : firstPassed === 0 ? "Baseline" : `Iteration ${firstPassed}`;

    const cells = s.iterations.map(iter => {
      const result = iter.testResults.find(r => r.testCaseId === tcId);
      if (!result) return '<td class="cell-na">—</td>';
      return result.passed
        ? '<td class="cell-pass">PASS</td>'
        : '<td class="cell-fail">FAIL</td>';
    }).join("");

    return `<tr>
      <td>${guard}…</td>
      <td>${expected}</td>
      <td>${fixtureId}</td>
      ${cells}
      <td>${firstPassedLabel}</td>
    </tr>`;
  }).join("\n");

  return `
<h2>Per-Test Results</h2>
<table>
  <thead>
    <tr><th>Test</th><th>Expected</th><th>Target</th>${iterHeaders}<th>First Passed</th></tr>
  </thead>
  <tbody>${rows}</tbody>
</table>`;
}

// ── Judge Table ──

function buildJudgeTable(j: BenchmarkReport["judgeEval"]): string {
  if (!j) return `<h2>LLM-as-Judge Evaluation</h2><p style="color:var(--text-muted)">Skipped (BENCHMARK_SKIP_JUDGE=1)</p>`;

  const scoreClass = (g: string) =>
    g === "generalizable" ? "score-good" : g === "likely_overfitting" ? "score-bad" : "score-warn";
  const robustClass = (r: string) =>
    r === "robust" ? "score-good" : r === "fragile" ? "score-bad" : "score-warn";

  const rows = j.changes.map(c => `<tr>
    <td>${esc(c.changeDescription)}</td>
    <td>${c.iteration}</td>
    <td class="${scoreClass(c.generalizability)}">${c.generalizability}</td>
    <td class="${robustClass(c.paraphraseRobustness)}">${c.paraphraseRobustness}</td>
    <td class="${c.rootCauseAddressed ? "score-good" : "score-warn"}">${c.rootCauseAddressed ? "✓ Yes" : "~ Partial"}</td>
    <td>${esc(c.reasoning)}</td>
  </tr>`).join("\n");

  return `
<h2>LLM-as-Judge Evaluation</h2>
<p style="color:var(--text-muted);font-size:0.85rem;margin-bottom:1rem">
  Overall score: ${j.overallScore.toFixed(1)} / 5 — ${esc(j.summary)}
</p>
<table>
  <thead>
    <tr><th>Change</th><th>Iter</th><th>Generalizability</th><th>Paraphrase</th><th>Root Cause</th><th>Reasoning</th></tr>
  </thead>
  <tbody>${rows}</tbody>
</table>`;
}

// ── Raw Data ──

function buildRawData(s: BenchmarkReport["session"], r: BenchmarkReport): string {
  // Conversation trace per iteration (separate from the collapsed raw JSON)
  const traceSection = s.iterations
    .filter(iter => iter.iteration > 0 && iter.conversationTrace.length > 0)
    .map(iter => {
      const turns = iter.conversationTrace.map(turn => {
        const cardSummary = turn.cards.map((c: any) => c.type).join(", ") || "none";
        const toolSummary = turn.toolCalls.map(tc => `${tc.title} [${tc.resultStatus ?? tc.status}]`).join(", ") || "none";
        return `<div style="margin-bottom:1rem;padding:0.75rem;background:var(--bg);border-radius:4px;border:1px solid var(--border)">
  <div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:0.5rem">Turn ${turn.turnIndex + 1}</div>
  <div style="margin-bottom:0.5rem"><span style="color:var(--accent)">Prompt:</span> <code>${esc(turn.promptSent.slice(0, 300))}${turn.promptSent.length > 300 ? "…" : ""}</code></div>
  <div style="margin-bottom:0.5rem"><span style="color:var(--pass)">Response:</span> ${esc(turn.agentResponse.slice(0, 500))}${turn.agentResponse.length > 500 ? "…" : ""}</div>
  <div style="font-size:0.8rem;color:var(--text-muted)">Cards: ${cardSummary} · Tools: ${toolSummary}</div>
</div>`;
      }).join("\n");

      const target = iter.targetFixtureTestId ?? "unknown";
      return `<details>
  <summary>Iteration ${iter.iteration} — Conversation Trace (${iter.conversationTrace.length} turns, target: ${esc(target)})</summary>
  <div>${turns}</div>
</details>`;
    }).join("\n");

  // Raw JSON sections
  const sections = s.iterations.map(iter => {
    const title = iter.iteration === 0
      ? "Iteration 0 — Baseline Test Results"
      : `Iteration ${iter.iteration} — Agent Response &amp; Tool Calls`;

    const content = JSON.stringify({
      iteration: iter.iteration,
      timestamp: new Date(iter.timestamp).toISOString(),
      latencyMs: iter.latencyMs,
      proposalEmitted: iter.proposalEmitted,
      buildErrorOccurred: iter.buildErrorOccurred,
      prompt: iter.prompt,
      agentResponseText: iter.agentResponseText,
      cards: iter.agentCards,
      toolCalls: iter.toolCalls,
      contextRetrievals: extractContextRetrievals(iter.toolCalls),
      proposalCards: iter.proposalCards,
      testResults: iter.testResults,
    }, null, 2);

    return `<details>
  <summary>${title}</summary>
  <div><pre><code>${esc(content)}</code></pre></div>
</details>`;
  }).join("\n");

  const metaContent = JSON.stringify({
    benchmarkVersion: "1.0.0",
    runId: r.runId,
    startTime: r.startTime,
    endTime: r.endTime,
    fixture: r.fixture,
    config: r.config,
    environment: r.environment,
    ephemeralPolicy: r.ephemeralPolicy,
    timing: r.timing,
  }, null, 2);

  return `
<h2>Conversation Traces</h2>
<p style="color:var(--text-muted);font-size:0.85rem;margin-bottom:1rem">
  Full conversation flow per iteration — each turn shows the prompt sent, agent response, cards emitted, and tool calls.
  Use this to identify where the agent's reasoning breaks down or where the prompt could be more directive.
</p>
${traceSection}

<h2>Raw Data</h2>
${sections}
<details>
  <summary>Benchmark Metadata</summary>
  <div><pre><code>${esc(metaContent)}</code></pre></div>
</details>`;
}

// ── Chart.js Script ──

function buildChartScript(
  s: BenchmarkReport["session"],
  d: BenchmarkReport["deterministicEval"],
): string {
  const labels = s.iterations.map(i => i.iteration === 0 ? "Baseline" : `Iter ${i.iteration}`);
  const passingData = s.iterations.map(i => i.passingTests);
  const totalLine = s.iterations.map(() => s.totalTests);
  const latencyData = s.iterations.map(i => Math.round(i.latencyMs / 1000));

  // Per-test convergence chart data
  const testLabels = d.perTestConvergence.map(c => c.fixtureTestId);
  const testData = d.perTestConvergence.map(c => c.firstPassedAtIteration ?? d.iterationsToConverge + 1);
  const testColors = d.perTestConvergence.map(c => {
    if (c.firstPassedAtIteration === null) return "#ef4444";
    if (c.firstPassedAtIteration === 0) return "#22c55e";
    if (c.firstPassedAtIteration <= 1) return "#3b82f6";
    return "#f59e0b";
  });

  return `<script>
Chart.defaults.color = '#94a3b8';
Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

new Chart(document.getElementById('testsPassingChart'), {
  type: 'line',
  data: {
    labels: ${JSON.stringify(labels)},
    datasets: [{
      label: 'Tests Passing',
      data: ${JSON.stringify(passingData)},
      borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)',
      fill: true, tension: 0.3, pointRadius: 6, pointBackgroundColor: '#3b82f6',
    }, {
      label: 'Total Tests',
      data: ${JSON.stringify(totalLine)},
      borderColor: '#475569', borderDash: [5,5], pointRadius: 0, fill: false,
    }]
  },
  options: {
    responsive: true,
    plugins: { legend: { position: 'bottom' } },
    scales: {
      y: { beginAtZero: true, max: ${s.totalTests + 1}, ticks: { stepSize: 1 }, grid: { color: '#1e293b' } },
      x: { grid: { color: '#1e293b' } }
    }
  }
});

new Chart(document.getElementById('latencyChart'), {
  type: 'bar',
  data: {
    labels: ${JSON.stringify(labels)},
    datasets: [{ label: 'Latency (s)', data: ${JSON.stringify(latencyData)}, backgroundColor: '#3b82f6' }]
  },
  options: {
    responsive: true,
    plugins: { legend: { position: 'bottom' } },
    scales: {
      y: { beginAtZero: true, title: { display: true, text: 'Seconds' }, grid: { color: '#1e293b' } },
      x: { grid: { color: '#1e293b' } }
    }
  }
});

new Chart(document.getElementById('convergenceChart'), {
  type: 'bar',
  data: {
    labels: ${JSON.stringify(testLabels)},
    datasets: [{
      label: 'First passed at iteration',
      data: ${JSON.stringify(testData)},
      backgroundColor: ${JSON.stringify(testColors)},
      borderRadius: 4,
    }]
  },
  options: {
    indexAxis: 'y', responsive: true,
    plugins: { legend: { display: false },
      tooltip: { callbacks: { label: (ctx) => ctx.raw === 0 ? 'Passed at baseline' : 'First passed at iteration ' + ctx.raw } }
    },
    scales: {
      x: { beginAtZero: true, max: ${Math.max(d.iterationsToConverge + 2, 5)}, ticks: { stepSize: 1 }, title: { display: true, text: 'Iteration' }, grid: { color: '#1e293b' } },
      y: { grid: { display: false } }
    }
  }
});
</script>`;
}
