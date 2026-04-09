/**
 * Context Index — in-memory index over policy data for efficient retrieval.
 *
 * Holds the full policy definition, source document, fidelity report, and
 * derived lookup maps. Never serialized into agent context. The MCP search
 * tools (Phase 2) and the compact context builder query this directly.
 *
 * Built incrementally:
 *   Stage 1 (definition-only): variableToRules, ruleToVariables
 *   Stage 2 (+document): documentSections, documentText
 *   Stage 3 (+fidelity): ruleToSections, variableToSections, statementToSection
 */
import type {
  PolicyDefinition,
  PolicyRule,
  PolicyVariable,
  FidelityReport,
  FidelityRuleReport,
  FidelityVariableReport,
  DocumentSection,
  TestCaseWithResult,
  QualityReportIssue,
  SectionImportStatus,
  AutomatedReasoningCheckFinding,
} from "../types";
import { extractRelevantRuleIds, extractRelevantVariables } from "../utils/test-findings";

// ── SMT-LIB keywords that are NOT variable references ──

const SMTLIB_KEYWORDS = new Set([
  "=>", "and", "or", "not", "=", "<", ">", "<=", ">=",
  "true", "false", "ite", "let", "forall", "exists",
]);

// ── Public types ──

export interface ContextIndex {
  policyDefinition: PolicyDefinition;
  documentSections: DocumentSection[];
  documentText: string;
  fidelityReport: FidelityReport | null;
  testCases: TestCaseWithResult[];

  // Derived indexes
  variableToRules: Map<string, string[]>;
  ruleToVariables: Map<string, string[]>;
  ruleToSections: Map<string, string[]>;
  variableToSections: Map<string, string[]>;
  statementToSection: Map<string, string>;

  // Availability flags
  hasFidelityEdges: boolean;
  fidelityStale: boolean;
}

/** Compact outline sent to the agent every turn in compact mode. */
export interface PolicyOutline {
  policyArn: string;
  contextMode: "compact";
  summary: {
    ruleCount: number;
    variableCount: number;
    typeCount: number;
    documentSectionCount: number;
    documentTotalLines: number;
    fidelityAvailable: boolean;
    fidelityStale: boolean;
    coverageScore: number | null;
    accuracyScore: number | null;
  };
  documentOutline: {
    sectionId: string;
    title: string;
    level: number;
    startLine: number;
    endLine: number;
    groundedRuleCount: number;
    groundedVariableCount: number;
    importStatus?: SectionImportStatus;
  }[];
  typeDefinitions: PolicyDefinition["types"];
  qualityIssues: QualityReportIssue[];
}

/** Pre-selected context for a specific failing test. */
export interface TaskContext {
  targetTest: TestCaseWithResult;
  relevantRules: PolicyRule[];
  relevantVariables: PolicyVariable[];
  relevantDocumentExcerpts: {
    sectionId: string;
    sectionTitle: string;
    text: string;
    lineStart: number;
    lineEnd: number;
  }[];
  relevantFidelity: {
    ruleReports: Record<string, FidelityRuleReport>;
    variableReports: Record<string, FidelityVariableReport>;
  };
}

// ── Index construction ──

/**
 * Extract variable names referenced in an SMT-LIB expression.
 * Tokenizes the S-expression and filters out keywords and numeric literals.
 */
export function extractVariablesFromExpression(
  expression: string,
  knownVariables: Set<string>,
): string[] {
  // Tokenize: split on parens and whitespace, keep non-empty tokens
  const tokens = expression
    .replace(/[()]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);

  const found = new Set<string>();
  for (const token of tokens) {
    if (SMTLIB_KEYWORDS.has(token)) continue;
    if (/^-?\d+(\.\d+)?$/.test(token)) continue; // numeric literal
    if (knownVariables.has(token)) found.add(token);
  }
  return [...found];
}

/**
 * Build definition-derived indexes: variableToRules and ruleToVariables.
 */
function buildDefinitionEdges(
  definition: PolicyDefinition,
): { variableToRules: Map<string, string[]>; ruleToVariables: Map<string, string[]> } {
  const variableToRules = new Map<string, string[]>();
  const ruleToVariables = new Map<string, string[]>();
  const knownVars = new Set(definition.variables.map((v) => v.name));

  for (const rule of definition.rules) {
    const vars = extractVariablesFromExpression(rule.expression, knownVars);
    ruleToVariables.set(rule.ruleId, vars);
    for (const v of vars) {
      const existing = variableToRules.get(v);
      if (existing) existing.push(rule.ruleId);
      else variableToRules.set(v, [rule.ruleId]);
    }
  }

  return { variableToRules, ruleToVariables };
}

/**
 * Build fidelity-derived indexes: ruleToSections, variableToSections, statementToSection.
 */
function buildFidelityEdges(
  fidelityReport: FidelityReport,
  documentSections: DocumentSection[],
): {
  ruleToSections: Map<string, string[]>;
  variableToSections: Map<string, string[]>;
  statementToSection: Map<string, string>;
} {
  const ruleToSections = new Map<string, string[]>();
  const variableToSections = new Map<string, string[]>();
  const statementToSection = new Map<string, string>();

  // Build statement → section mapping using text-based matching.
  // Fidelity report line numbers use an internal numbering scheme that
  // doesn't correspond to raw document line numbers, so we match
  // atomic statement text against section content instead.
  for (const doc of fidelityReport.documentSources ?? []) {
    for (const stmt of doc.atomicStatements ?? []) {
      if (!stmt.text) continue;
      const normalizedText = stmt.text.toLowerCase();
      const section = documentSections.find(
        (s) => s.content.toLowerCase().includes(normalizedText),
      );
      if (section) {
        statementToSection.set(stmt.id, section.id);
      }
    }
  }

  // Map rules → sections via grounding statements
  for (const [ruleId, report] of Object.entries(fidelityReport.ruleReports ?? {})) {
    const sectionIds = new Set<string>();
    for (const ref of report.groundingStatements ?? []) {
      const sectionId = statementToSection.get(ref.statementId);
      if (sectionId) sectionIds.add(sectionId);
    }
    if (sectionIds.size > 0) {
      ruleToSections.set(ruleId, [...sectionIds]);
    }
  }

  // Map variables → sections via grounding statements
  for (const [varName, report] of Object.entries(fidelityReport.variableReports ?? {})) {
    const sectionIds = new Set<string>();
    for (const ref of report.groundingStatements ?? []) {
      const sectionId = statementToSection.get(ref.statementId);
      if (sectionId) sectionIds.add(sectionId);
    }
    if (sectionIds.size > 0) {
      variableToSections.set(varName, [...sectionIds]);
    }
  }

  return { ruleToSections, variableToSections, statementToSection };
}

/**
 * Build a ContextIndex incrementally from available data.
 * All parameters except `definition` are optional — the index
 * degrades gracefully when data is missing.
 */
export function buildContextIndex(
  definition: PolicyDefinition,
  documentText: string | null,
  documentSections: DocumentSection[],
  fidelityReport: FidelityReport | null,
  testCases: TestCaseWithResult[],
): ContextIndex {
  const { variableToRules, ruleToVariables } = buildDefinitionEdges(definition);

  let ruleToSections = new Map<string, string[]>();
  let variableToSections = new Map<string, string[]>();
  let statementToSection = new Map<string, string>();
  let hasFidelityEdges = false;

  if (fidelityReport && documentSections.length > 0) {
    const fidelityEdges = buildFidelityEdges(fidelityReport, documentSections);
    ruleToSections = fidelityEdges.ruleToSections;
    variableToSections = fidelityEdges.variableToSections;
    statementToSection = fidelityEdges.statementToSection;
    hasFidelityEdges = true;
  }

  return {
    policyDefinition: definition,
    documentSections,
    documentText: documentText ?? "",
    fidelityReport,
    testCases,
    variableToRules,
    ruleToVariables,
    ruleToSections,
    variableToSections,
    statementToSection,
    hasFidelityEdges,
    fidelityStale: false,
  };
}

// ── Compact context builder ──

/**
 * Build the structural outline for compact mode.
 */
export function buildPolicyOutline(
  index: ContextIndex,
  policyArn: string,
  qualityIssues: QualityReportIssue[],
  sectionImportStatuses?: Record<string, SectionImportStatus>,
): PolicyOutline {
  const def = index.policyDefinition;
  const fr = index.fidelityReport;

  // Compute per-section grounded counts by inverting ruleToSections / variableToSections
  const sectionRuleCounts = new Map<string, number>();
  const sectionVarCounts = new Map<string, number>();
  for (const sectionIds of index.ruleToSections.values()) {
    for (const sid of sectionIds) {
      sectionRuleCounts.set(sid, (sectionRuleCounts.get(sid) ?? 0) + 1);
    }
  }
  for (const sectionIds of index.variableToSections.values()) {
    for (const sid of sectionIds) {
      sectionVarCounts.set(sid, (sectionVarCounts.get(sid) ?? 0) + 1);
    }
  }

  const lastLine = index.documentSections.reduce(
    (max, s) => Math.max(max, s.endLine), 0,
  );

  return {
    policyArn,
    contextMode: "compact",
    summary: {
      ruleCount: def.rules.length,
      variableCount: def.variables.length,
      typeCount: def.types.length,
      documentSectionCount: index.documentSections.length,
      documentTotalLines: lastLine,
      fidelityAvailable: index.hasFidelityEdges,
      fidelityStale: index.fidelityStale,
      coverageScore: fr?.coverageScore ?? null,
      accuracyScore: fr?.accuracyScore ?? null,
    },
    documentOutline: index.documentSections.map((s) => ({
      sectionId: s.id,
      title: s.title,
      level: s.level,
      startLine: s.startLine,
      endLine: s.endLine,
      groundedRuleCount: sectionRuleCounts.get(s.id) ?? 0,
      groundedVariableCount: sectionVarCounts.get(s.id) ?? 0,
      ...(sectionImportStatuses?.[s.id] != null && { importStatus: sectionImportStatuses[s.id] }),
    })),
    typeDefinitions: def.types,
    qualityIssues,
  };
}

/**
 * Build task-relevant context for a specific failing test.
 *
 * Traces from the test findings through the index graph to collect
 * the rules, variables, document excerpts, and fidelity assessments
 * relevant to diagnosing the failure.
 */
export function buildTaskContext(
  index: ContextIndex,
  targetTest: TestCaseWithResult,
): TaskContext {
  const def = index.policyDefinition;
  const findings: AutomatedReasoningCheckFinding[] = targetTest.testFindings ?? [];

  // Step 1 & 2: Extract directly referenced rule IDs and variable names
  // Reuses the existing extraction utilities from test-findings.ts
  const ruleIds = new Set(extractRelevantRuleIds(findings));
  const varNames = new Set(extractRelevantVariables(findings, def));

  // Step 3: Expand one hop via the index graph
  for (const varName of [...varNames]) {
    for (const rId of index.variableToRules.get(varName) ?? []) {
      ruleIds.add(rId);
    }
  }
  for (const ruleId of [...ruleIds]) {
    for (const vName of index.ruleToVariables.get(ruleId) ?? []) {
      varNames.add(vName);
    }
  }

  // Collect full rule and variable objects
  const ruleMap = new Map(def.rules.map((r) => [r.ruleId, r]));
  const varMap = new Map(def.variables.map((v) => [v.name, v]));
  // Safe: filter(Boolean) removes undefined entries from Map.get() misses
  const relevantRules = [...ruleIds].map((id) => ruleMap.get(id)).filter(Boolean) as PolicyRule[];
  const relevantVariables = [...varNames].map((n) => varMap.get(n)).filter(Boolean) as PolicyVariable[];

  // Step 4: Map to document sections and extract excerpts
  const sectionIds = new Set<string>();
  for (const ruleId of ruleIds) {
    for (const sid of index.ruleToSections.get(ruleId) ?? []) sectionIds.add(sid);
  }
  for (const varName of varNames) {
    for (const sid of index.variableToSections.get(varName) ?? []) sectionIds.add(sid);
  }

  // Fallback for NO_TRANSLATIONS: text-search the document
  if (ruleIds.size === 0 && varNames.size === 0 && index.documentSections.length > 0) {
    const testText = [
      targetTest.testCase?.guardContent ?? "",
      targetTest.testCase?.queryContent ?? "",
    ].join(" ").toLowerCase();
    const terms = testText.split(/\s+/).filter((t) => t.length > 3);
    if (terms.length > 0) {
      const scored = index.documentSections.map((s) => {
        const lower = s.content.toLowerCase();
        const score = terms.reduce((acc, t) => acc + (lower.includes(t) ? 1 : 0), 0);
        return { section: s, score };
      });
      scored.sort((a, b) => b.score - a.score);
      for (const { section, score } of scored.slice(0, 3)) {
        if (score > 0) sectionIds.add(section.id);
      }
    }
  }

  const sectionMap = new Map(index.documentSections.map((s) => [s.id, s]));
  const relevantDocumentExcerpts = [...sectionIds]
    .map((sid) => sectionMap.get(sid))
    .filter(Boolean)
    .map((s) => ({
      sectionId: s!.id,
      sectionTitle: s!.title,
      text: s!.content,
      lineStart: s!.startLine,
      lineEnd: s!.endLine,
    }));

  // Step 5: Collect fidelity assessments
  const fr = index.fidelityReport;
  const relevantRuleReports: Record<string, FidelityRuleReport> = {};
  const relevantVarReports: Record<string, FidelityVariableReport> = {};
  if (fr) {
    for (const ruleId of ruleIds) {
      const report = fr.ruleReports?.[ruleId];
      if (report) relevantRuleReports[ruleId] = report;
    }
    for (const varName of varNames) {
      const report = fr.variableReports?.[varName];
      if (report) relevantVarReports[varName] = report;
    }
  }

  return {
    targetTest,
    relevantRules,
    relevantVariables,
    relevantDocumentExcerpts,
    relevantFidelity: {
      ruleReports: relevantRuleReports,
      variableReports: relevantVarReports,
    },
  };
}

// ── Size estimation ──

/** Default threshold in bytes — switch to compact mode above this. */
export const DEFAULT_COMPACT_THRESHOLD_BYTES = 100_000;

/**
 * Estimate the serialized size of the full context.
 * Uses a rough heuristic rather than actual JSON.stringify to avoid the cost.
 */
export function estimateContextSize(
  definition: PolicyDefinition,
  documentText: string | null,
): number {
  // Rule: ~200 bytes per rule (expression + description + metadata)
  const ruleSize = (definition.rules?.length ?? 0) * 200;
  // Variable: ~250 bytes per variable (name + type + description with synonyms)
  const varSize = (definition.variables?.length ?? 0) * 250;
  // Types: ~100 bytes per type value
  const typeSize = (definition.types ?? []).reduce(
    (acc, t) => acc + (t.values?.length ?? 0) * 100, 0,
  );
  const docSize = documentText?.length ?? 0;

  return ruleSize + varSize + typeSize + docSize;
}

// ── Query methods (used by MCP search tools) ──

/** Result from a document search. */
export interface DocumentSearchResult {
  sectionId: string;
  sectionTitle: string;
  matchingText: string;
  lineStart: number;
  lineEnd: number;
  score: number;
}

/**
 * Full-text search over document sections.
 * Splits query into terms, scores sections by term frequency,
 * returns top N with matching lines and ±5 lines of context.
 */
export function searchDocument(
  index: ContextIndex,
  query: string,
  maxResults = 5,
): DocumentSearchResult[] {
  if (index.documentSections.length === 0) return [];

  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return [];

  const scored: DocumentSearchResult[] = [];

  for (const section of index.documentSections) {
    const lines = section.content.split("\n");
    const lowerContent = section.content.toLowerCase();

    // Score by total term occurrences
    let score = 0;
    for (const term of terms) {
      let pos = 0;
      while ((pos = lowerContent.indexOf(term, pos)) !== -1) {
        score++;
        pos += term.length;
      }
    }
    if (score === 0) continue;

    // Extract matching lines with ±5 lines of context
    const matchingLineIndices = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i].toLowerCase();
      if (terms.some((t) => lower.includes(t))) {
        for (let j = Math.max(0, i - 5); j <= Math.min(lines.length - 1, i + 5); j++) {
          matchingLineIndices.add(j);
        }
      }
    }

    const sortedIndices = [...matchingLineIndices].sort((a, b) => a - b);
    const matchingText = sortedIndices.map((i) => lines[i]).join("\n");

    scored.push({
      sectionId: section.id,
      sectionTitle: section.title,
      matchingText,
      lineStart: section.startLine,
      lineEnd: section.endLine,
      score,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults);
}

/** Result from a rule search. */
export interface RuleSearchResult {
  ruleId: string;
  description: string;
  expression: string;
  accuracyScore?: number;
  referencedVariables: string[];
  score: number;
}

/**
 * Search rules by keyword across descriptions and expressions.
 */
export function searchRules(
  index: ContextIndex,
  query: string,
  maxResults = 10,
): RuleSearchResult[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return [];

  const results: RuleSearchResult[] = [];

  for (const rule of index.policyDefinition.rules) {
    const searchText = `${rule.description} ${rule.expression}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      let pos = 0;
      while ((pos = searchText.indexOf(term, pos)) !== -1) {
        score++;
        pos += term.length;
      }
    }
    if (score === 0) continue;

    results.push({
      ruleId: rule.ruleId,
      description: rule.description,
      expression: rule.expression,
      accuracyScore: index.fidelityReport?.ruleReports?.[rule.ruleId]?.accuracyScore,
      referencedVariables: index.ruleToVariables.get(rule.ruleId) ?? [],
      score,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}

/** Result from a variable search. */
export interface VariableSearchResult {
  name: string;
  type: string;
  description: string;
  accuracyScore?: number;
  referencedByRules: string[];
  score: number;
}

/**
 * Search variables by keyword across names and descriptions.
 */
export function searchVariables(
  index: ContextIndex,
  query: string,
  maxResults = 10,
): VariableSearchResult[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return [];

  const results: VariableSearchResult[] = [];

  for (const v of index.policyDefinition.variables) {
    const searchText = `${v.name} ${v.description}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      let pos = 0;
      while ((pos = searchText.indexOf(term, pos)) !== -1) {
        score++;
        pos += term.length;
      }
    }
    if (score === 0) continue;

    results.push({
      name: v.name,
      type: v.type,
      description: v.description,
      accuracyScore: index.fidelityReport?.variableReports?.[v.name]?.accuracyScore,
      referencedByRules: index.variableToRules.get(v.name) ?? [],
      score,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}

/** Result from get_section_rules. */
export interface SectionRulesResult {
  sectionId: string;
  sectionTitle: string;
  rules: PolicyRule[];
  variables: PolicyVariable[];
  ruleReports: Record<string, FidelityRuleReport>;
  variableReports: Record<string, FidelityVariableReport>;
}

/**
 * Get all rules and variables grounded in a specific document section.
 * Caps at 50 rules and 50 variables to prevent context explosion.
 */
export function getSectionRules(
  index: ContextIndex,
  sectionId: string,
): SectionRulesResult | null {
  const section = index.documentSections.find((s) => s.id === sectionId);
  if (!section) return null;

  // Invert ruleToSections to find rules grounded in this section
  const ruleIds: string[] = [];
  for (const [ruleId, sectionIds] of index.ruleToSections) {
    if (sectionIds.includes(sectionId)) ruleIds.push(ruleId);
  }

  // Invert variableToSections to find variables grounded in this section
  const varNames: string[] = [];
  for (const [varName, sectionIds] of index.variableToSections) {
    if (sectionIds.includes(sectionId)) varNames.push(varName);
  }

  const ruleMap = new Map(index.policyDefinition.rules.map((r) => [r.ruleId, r]));
  const varMap = new Map(index.policyDefinition.variables.map((v) => [v.name, v]));

  const rules = ruleIds.slice(0, 50)
    .map((id) => ruleMap.get(id))
    .filter(Boolean) as PolicyRule[];
  const variables = varNames.slice(0, 50)
    .map((n) => varMap.get(n))
    .filter(Boolean) as PolicyVariable[];

  // Collect fidelity reports
  const ruleReports: Record<string, FidelityRuleReport> = {};
  const variableReports: Record<string, FidelityVariableReport> = {};
  if (index.fidelityReport) {
    for (const ruleId of ruleIds.slice(0, 50)) {
      const report = index.fidelityReport.ruleReports?.[ruleId];
      if (report) ruleReports[ruleId] = report;
    }
    for (const varName of varNames.slice(0, 50)) {
      const report = index.fidelityReport.variableReports?.[varName];
      if (report) variableReports[varName] = report;
    }
  }

  return {
    sectionId: section.id,
    sectionTitle: section.title,
    rules,
    variables,
    ruleReports,
    variableReports,
  };
}

/** Result item from get_rule_details. */
export interface RuleDetailResult {
  rule: PolicyRule;
  fidelityReport?: FidelityRuleReport;
  groundingText: string[];
  referencedVariables: string[];
}

/**
 * Get full details for specific rules by ID.
 */
export function getRuleDetails(
  index: ContextIndex,
  ruleIds: string[],
): RuleDetailResult[] {
  const ruleMap = new Map(index.policyDefinition.rules.map((r) => [r.ruleId, r]));

  // Build statement text lookup from fidelity report
  const stmtTextMap = new Map<string, string>();
  if (index.fidelityReport) {
    for (const doc of index.fidelityReport.documentSources ?? []) {
      for (const stmt of doc.atomicStatements ?? []) {
        stmtTextMap.set(stmt.id, stmt.text);
      }
    }
  }

  const results: RuleDetailResult[] = [];
  for (const ruleId of ruleIds.slice(0, 20)) {
    const rule = ruleMap.get(ruleId);
    if (!rule) continue;

    const fr = index.fidelityReport?.ruleReports?.[ruleId];
    const groundingText: string[] = [];
    if (fr) {
      for (const ref of fr.groundingStatements ?? []) {
        const text = stmtTextMap.get(ref.statementId);
        if (text) groundingText.push(text);
      }
    }

    results.push({
      rule,
      fidelityReport: fr,
      groundingText,
      referencedVariables: index.ruleToVariables.get(ruleId) ?? [],
    });
  }

  return results;
}

/** Result item from get_variable_details. */
export interface VariableDetailResult {
  variable: PolicyVariable;
  fidelityReport?: FidelityVariableReport;
  groundingText: string[];
  referencedByRules: string[];
}

/**
 * Get full details for specific variables by name.
 */
export function getVariableDetails(
  index: ContextIndex,
  variableNames: string[],
): VariableDetailResult[] {
  const varMap = new Map(index.policyDefinition.variables.map((v) => [v.name, v]));

  const stmtTextMap = new Map<string, string>();
  if (index.fidelityReport) {
    for (const doc of index.fidelityReport.documentSources ?? []) {
      for (const stmt of doc.atomicStatements ?? []) {
        stmtTextMap.set(stmt.id, stmt.text);
      }
    }
  }

  const results: VariableDetailResult[] = [];
  for (const name of variableNames.slice(0, 20)) {
    const variable = varMap.get(name);
    if (!variable) continue;

    const fr = index.fidelityReport?.variableReports?.[name];
    const groundingText: string[] = [];
    if (fr) {
      for (const ref of fr.groundingStatements ?? []) {
        const text = stmtTextMap.get(ref.statementId);
        if (text) groundingText.push(text);
      }
    }

    results.push({
      variable,
      fidelityReport: fr,
      groundingText,
      referencedByRules: index.variableToRules.get(name) ?? [],
    });
  }

  return results;
}

/** Summary item returned by find_related_content. */
export interface RelatedContentItem {
  type: "rule" | "variable" | "section";
  id: string;
  description: string;
}

/**
 * Graph traversal: find all content related to a rule or variable.
 * Depth 1 = direct connections. Depth 2 = connections of connections.
 * Capped at 50 items total.
 */
export function findRelatedContent(
  index: ContextIndex,
  ruleId?: string,
  variableName?: string,
  depth = 1,
): RelatedContentItem[] {
  const visited = new Set<string>();
  const items: RelatedContentItem[] = [];
  const maxItems = 50;
  const effectiveDepth = Math.min(Math.max(depth, 1), 2);

  const ruleMap = new Map(index.policyDefinition.rules.map((r) => [r.ruleId, r]));
  const varMap = new Map(index.policyDefinition.variables.map((v) => [v.name, v]));
  const sectionMap = new Map(index.documentSections.map((s) => [s.id, s]));

  // Seed nodes
  const ruleQueue: string[] = ruleId ? [ruleId] : [];
  const varQueue: string[] = variableName ? [variableName] : [];

  for (let d = 0; d < effectiveDepth && items.length < maxItems; d++) {
    const nextRules: string[] = [];
    const nextVars: string[] = [];

    // Expand rules
    for (const rid of ruleQueue) {
      if (visited.has(`rule:${rid}`)) continue;
      visited.add(`rule:${rid}`);

      const rule = ruleMap.get(rid);
      if (rule && items.length < maxItems) {
        items.push({ type: "rule", id: rid, description: rule.description });
      }

      // Connected variables
      for (const vn of index.ruleToVariables.get(rid) ?? []) {
        if (!visited.has(`var:${vn}`)) nextVars.push(vn);
      }
      // Connected sections
      for (const sid of index.ruleToSections.get(rid) ?? []) {
        if (!visited.has(`section:${sid}`) && items.length < maxItems) {
          visited.add(`section:${sid}`);
          const sec = sectionMap.get(sid);
          if (sec) items.push({ type: "section", id: sid, description: sec.title });
        }
      }
    }

    // Expand variables
    for (const vn of varQueue) {
      if (visited.has(`var:${vn}`)) continue;
      visited.add(`var:${vn}`);

      const v = varMap.get(vn);
      if (v && items.length < maxItems) {
        items.push({ type: "variable", id: vn, description: `${v.name} (${v.type})` });
      }

      // Connected rules
      for (const rid of index.variableToRules.get(vn) ?? []) {
        if (!visited.has(`rule:${rid}`)) nextRules.push(rid);
      }
      // Connected sections
      for (const sid of index.variableToSections.get(vn) ?? []) {
        if (!visited.has(`section:${sid}`) && items.length < maxItems) {
          visited.add(`section:${sid}`);
          const sec = sectionMap.get(sid);
          if (sec) items.push({ type: "section", id: sid, description: sec.title });
        }
      }
    }

    ruleQueue.length = 0;
    ruleQueue.push(...nextRules);
    varQueue.length = 0;
    varQueue.push(...nextVars);
  }

  return items;
}

// ── Serialization (for cross-process communication) ──

/** Serializable form of the ContextIndex (Maps → plain objects). */
interface SerializedContextIndex {
  policyDefinition: PolicyDefinition;
  documentSections: DocumentSection[];
  documentText: string;
  fidelityReport: FidelityReport | null;
  testCases: TestCaseWithResult[];
  variableToRules: Record<string, string[]>;
  ruleToVariables: Record<string, string[]>;
  ruleToSections: Record<string, string[]>;
  variableToSections: Record<string, string[]>;
  statementToSection: Record<string, string>;
  hasFidelityEdges: boolean;
  fidelityStale: boolean;
}

/**
 * Serialize a ContextIndex to a plain JSON-compatible object.
 * Maps are converted to plain objects for JSON.stringify.
 */
export function serializeContextIndex(index: ContextIndex): SerializedContextIndex {
  return {
    policyDefinition: index.policyDefinition,
    documentSections: index.documentSections,
    documentText: index.documentText,
    fidelityReport: index.fidelityReport,
    testCases: index.testCases,
    variableToRules: Object.fromEntries(index.variableToRules),
    ruleToVariables: Object.fromEntries(index.ruleToVariables),
    ruleToSections: Object.fromEntries(index.ruleToSections),
    variableToSections: Object.fromEntries(index.variableToSections),
    statementToSection: Object.fromEntries(index.statementToSection),
    hasFidelityEdges: index.hasFidelityEdges,
    fidelityStale: index.fidelityStale,
  };
}

/**
 * Deserialize a plain object back into a ContextIndex.
 * Plain objects are converted back to Maps.
 */
export function deserializeContextIndex(raw: SerializedContextIndex): ContextIndex {
  return {
    policyDefinition: raw.policyDefinition,
    documentSections: raw.documentSections ?? [],
    documentText: raw.documentText ?? "",
    fidelityReport: raw.fidelityReport ?? null,
    testCases: raw.testCases ?? [],
    variableToRules: new Map(Object.entries(raw.variableToRules ?? {})),
    ruleToVariables: new Map(Object.entries(raw.ruleToVariables ?? {})),
    ruleToSections: new Map(Object.entries(raw.ruleToSections ?? {})),
    variableToSections: new Map(Object.entries(raw.variableToSections ?? {})),
    statementToSection: new Map(Object.entries(raw.statementToSection ?? {})),
    hasFidelityEdges: raw.hasFidelityEdges ?? false,
    fidelityStale: raw.fidelityStale ?? false,
  };
}
