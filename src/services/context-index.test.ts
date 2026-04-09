/**
 * Unit tests for the Context Index module.
 */
import { describe, it, expect } from "vitest";
import {
  buildContextIndex,
  buildPolicyOutline,
  buildTaskContext,
  extractVariablesFromExpression,
  estimateContextSize,
  DEFAULT_COMPACT_THRESHOLD_BYTES,
} from "./context-index";
import type { PolicyDefinition, DocumentSection, FidelityReport, TestCaseWithResult } from "../types";

// ── Test fixtures ──

function makeDefinition(overrides?: Partial<PolicyDefinition>): PolicyDefinition {
  return {
    version: "1.0",
    types: [],
    rules: [
      { ruleId: "R1", expression: "(=> (<= amount 100) autoApproved)", description: "Auto-approve small expenses" },
      { ruleId: "R2", expression: "(=> (> amount 5000) requiresFinanceApproval)", description: "Finance approval for large expenses" },
      { ruleId: "R3", expression: "(=> isInternational requiresFinanceApproval)", description: "International needs finance" },
    ],
    variables: [
      { name: "amount", type: "INT", description: "Expense amount in dollars" },
      { name: "autoApproved", type: "BOOL", description: "Whether auto-approved" },
      { name: "requiresFinanceApproval", type: "BOOL", description: "Whether finance approval needed" },
      { name: "isInternational", type: "BOOL", description: "Whether international travel" },
    ],
    ...overrides,
  };
}

function makeSections(): DocumentSection[] {
  return [
    { id: "s0-approval", title: "Approval Rules", level: 2, startLine: 0, endLine: 10, content: "## Approval Rules\n\nExpenses under $100 are auto-approved.\nExpenses over $5,000 need finance approval." },
    { id: "s1-international", title: "International Travel", level: 2, startLine: 10, endLine: 20, content: "## International Travel\n\nInternational travel always needs finance approval." },
    { id: "s2-reimbursement", title: "Reimbursement", level: 2, startLine: 20, endLine: 30, content: "## Reimbursement\n\nReimbursement within 5 days for expenses under $1,000." },
  ];
}

function makeFidelityReport(): FidelityReport {
  return {
    coverageScore: 0.85,
    accuracyScore: 0.9,
    ruleReports: {
      R1: {
        rule: "R1",
        groundingStatements: [{ documentId: "doc1", statementId: "S1" }],
        groundingJustifications: ["Matches auto-approval rule"],
        accuracyScore: 1.0,
        accuracyJustification: "Correct",
      },
      R2: {
        rule: "R2",
        groundingStatements: [{ documentId: "doc1", statementId: "S2" }],
        groundingJustifications: ["Matches finance threshold"],
        accuracyScore: 0.5,
        accuracyJustification: "Wrong threshold",
      },
      R3: {
        rule: "R3",
        groundingStatements: [{ documentId: "doc1", statementId: "S3" }],
        groundingJustifications: ["Matches international rule"],
        accuracyScore: 1.0,
      },
    },
    variableReports: {
      amount: {
        policyVariable: "amount",
        groundingStatements: [{ documentId: "doc1", statementId: "S1" }],
        accuracyScore: 1.0,
      },
      isInternational: {
        policyVariable: "isInternational",
        groundingStatements: [{ documentId: "doc1", statementId: "S3" }],
        accuracyScore: 1.0,
      },
    },
    documentSources: [{
      documentName: "expense-policy.md",
      documentHash: "abc123",
      documentId: "doc1",
      atomicStatements: [
        { id: "S1", text: "Expenses under $100 are auto-approved", location: { lines: [3] } },
        { id: "S2", text: "Expenses over $5,000 need finance approval", location: { lines: [4] } },
        { id: "S3", text: "International travel always needs finance approval", location: { lines: [12] } },
      ],
      documentContent: [],
    }],
  };
}

// ── extractVariablesFromExpression ──

describe("extractVariablesFromExpression", () => {
  const knownVars = new Set(["amount", "autoApproved", "requiresFinanceApproval", "isInternational"]);

  it("extracts variable names from a simple implication", () => {
    const result = extractVariablesFromExpression("(=> (<= amount 100) autoApproved)", knownVars);
    expect(result).toContain("amount");
    expect(result).toContain("autoApproved");
    expect(result).toHaveLength(2);
  });

  it("ignores SMT-LIB keywords", () => {
    const result = extractVariablesFromExpression("(=> (and (not isInternational) (= amount 50)) autoApproved)", knownVars);
    expect(result).not.toContain("=>");
    expect(result).not.toContain("and");
    expect(result).not.toContain("not");
    expect(result).toContain("isInternational");
    expect(result).toContain("amount");
    expect(result).toContain("autoApproved");
  });

  it("ignores numeric literals", () => {
    const result = extractVariablesFromExpression("(> amount 5000)", knownVars);
    expect(result).toEqual(["amount"]);
  });

  it("ignores negative numbers", () => {
    const result = extractVariablesFromExpression("(> amount -100)", knownVars);
    expect(result).toEqual(["amount"]);
  });

  it("ignores decimal numbers", () => {
    const result = extractVariablesFromExpression("(> amount 99.5)", knownVars);
    expect(result).toEqual(["amount"]);
  });

  it("ignores tokens not in knownVariables", () => {
    const result = extractVariablesFromExpression("(=> unknownVar autoApproved)", knownVars);
    expect(result).toEqual(["autoApproved"]);
  });

  it("deduplicates repeated variable references", () => {
    const result = extractVariablesFromExpression("(and (> amount 100) (< amount 5000))", knownVars);
    expect(result).toEqual(["amount"]);
  });

  it("handles empty expression", () => {
    expect(extractVariablesFromExpression("", knownVars)).toEqual([]);
  });

  it("handles boolean variable used directly (no operator)", () => {
    const result = extractVariablesFromExpression("(=> isInternational requiresFinanceApproval)", knownVars);
    expect(result).toContain("isInternational");
    expect(result).toContain("requiresFinanceApproval");
  });
});

// ── buildContextIndex ──

describe("buildContextIndex", () => {
  it("builds definition-derived edges without fidelity report", () => {
    const def = makeDefinition();
    const index = buildContextIndex(def, null, [], null, []);

    expect(index.hasFidelityEdges).toBe(false);
    expect(index.fidelityStale).toBe(false);

    // R1 references amount and autoApproved
    expect(index.ruleToVariables.get("R1")).toContain("amount");
    expect(index.ruleToVariables.get("R1")).toContain("autoApproved");

    // amount is referenced by R1 and R2
    expect(index.variableToRules.get("amount")).toContain("R1");
    expect(index.variableToRules.get("amount")).toContain("R2");

    // isInternational is referenced by R3
    expect(index.variableToRules.get("isInternational")).toEqual(["R3"]);
  });

  it("builds fidelity edges when report and sections are available", () => {
    const def = makeDefinition();
    const sections = makeSections();
    const fidelity = makeFidelityReport();
    const index = buildContextIndex(def, "doc text", sections, fidelity, []);

    expect(index.hasFidelityEdges).toBe(true);

    // S1 text "Expenses under $100 are auto-approved" is in section s0-approval
    expect(index.statementToSection.get("S1")).toBe("s0-approval");
    // S3 text "International travel always needs finance approval" is in section s1-international
    expect(index.statementToSection.get("S3")).toBe("s1-international");

    // R1 is grounded via S1 → s0-approval
    expect(index.ruleToSections.get("R1")).toContain("s0-approval");
    // R3 is grounded via S3 → s1-international
    expect(index.ruleToSections.get("R3")).toContain("s1-international");

    // isInternational variable grounded via S3 → s1-international
    expect(index.variableToSections.get("isInternational")).toContain("s1-international");
  });

  it("skips fidelity edges when sections are empty", () => {
    const def = makeDefinition();
    const fidelity = makeFidelityReport();
    const index = buildContextIndex(def, "doc text", [], fidelity, []);

    expect(index.hasFidelityEdges).toBe(false);
    expect(index.ruleToSections.size).toBe(0);
  });

  it("stores document text and sections", () => {
    const def = makeDefinition();
    const sections = makeSections();
    const index = buildContextIndex(def, "full doc text", sections, null, []);

    expect(index.documentText).toBe("full doc text");
    expect(index.documentSections).toBe(sections);
  });

  it("defaults documentText to empty string when null", () => {
    const def = makeDefinition();
    const index = buildContextIndex(def, null, [], null, []);
    expect(index.documentText).toBe("");
  });
});

// ── buildPolicyOutline ──

describe("buildPolicyOutline", () => {
  it("produces a compact outline with correct counts", () => {
    const def = makeDefinition();
    const sections = makeSections();
    const fidelity = makeFidelityReport();
    const index = buildContextIndex(def, "doc", sections, fidelity, []);

    const outline = buildPolicyOutline(index, "arn:test", []);

    expect(outline.contextMode).toBe("compact");
    expect(outline.policyArn).toBe("arn:test");
    expect(outline.summary.ruleCount).toBe(3);
    expect(outline.summary.variableCount).toBe(4);
    expect(outline.summary.fidelityAvailable).toBe(true);
    expect(outline.summary.fidelityStale).toBe(false);
    expect(outline.summary.coverageScore).toBe(0.85);
    expect(outline.summary.accuracyScore).toBe(0.9);
    expect(outline.documentOutline).toHaveLength(3);
  });

  it("includes per-section grounded counts", () => {
    const def = makeDefinition();
    const sections = makeSections();
    const fidelity = makeFidelityReport();
    const index = buildContextIndex(def, "doc", sections, fidelity, []);

    const outline = buildPolicyOutline(index, "arn:test", []);

    const approvalSection = outline.documentOutline.find((s) => s.sectionId === "s0-approval");
    // R1 and R2 are grounded in s0-approval (via S1 and S2)
    expect(approvalSection?.groundedRuleCount).toBeGreaterThanOrEqual(1);

    const intlSection = outline.documentOutline.find((s) => s.sectionId === "s1-international");
    // R3 is grounded in s1-international (via S3)
    expect(intlSection?.groundedRuleCount).toBe(1);
  });

  it("includes quality issues", () => {
    const def = makeDefinition();
    const index = buildContextIndex(def, null, [], null, []);
    const issues = [{ issueType: "conflicting_rules" as const, description: "Rules conflict" }];

    const outline = buildPolicyOutline(index, "arn:test", issues);
    expect(outline.qualityIssues).toHaveLength(1);
    expect(outline.qualityIssues[0].issueType).toBe("conflicting_rules");
  });

  it("includes section import statuses when provided", () => {
    const def = makeDefinition();
    const sections = makeSections();
    const index = buildContextIndex(def, "doc", sections, null, []);

    const outline = buildPolicyOutline(index, "arn:test", [], {
      "s0-approval": "completed",
      "s1-international": "in_progress",
    });

    expect(outline.documentOutline[0].importStatus).toBe("completed");
    expect(outline.documentOutline[1].importStatus).toBe("in_progress");
    expect(outline.documentOutline[2].importStatus).toBeUndefined();
  });

  it("handles empty sections gracefully", () => {
    const def = makeDefinition();
    const index = buildContextIndex(def, null, [], null, []);

    const outline = buildPolicyOutline(index, "arn:test", []);
    expect(outline.summary.documentSectionCount).toBe(0);
    expect(outline.summary.documentTotalLines).toBe(0);
    expect(outline.documentOutline).toHaveLength(0);
  });

  it("includes type definitions", () => {
    const def = makeDefinition({
      types: [{ name: "ExpenseCategory", description: "Category", values: [{ value: "TRAVEL", description: "Travel" }] }],
    });
    const index = buildContextIndex(def, null, [], null, []);

    const outline = buildPolicyOutline(index, "arn:test", []);
    expect(outline.typeDefinitions).toHaveLength(1);
    expect(outline.typeDefinitions[0].name).toBe("ExpenseCategory");
  });
});

// ── buildTaskContext ──

describe("buildTaskContext", () => {
  it("extracts relevant rules and variables from test findings", () => {
    const def = makeDefinition();
    const sections = makeSections();
    const fidelity = makeFidelityReport();
    const index = buildContextIndex(def, "doc", sections, fidelity, []);

    const testCase: TestCaseWithResult = {
      testCase: {
        testCaseId: "tc1",
        guardContent: "$50 expense",
        queryContent: "Is it auto-approved?",
        expectedAggregatedFindingsResult: "VALID",
      },
      aggregatedTestFindingsResult: "SATISFIABLE",
      testFindings: [{
        valid: {
          supportingRules: [{ id: "R1" }],
          translation: {
            premises: [{ logic: "(= amount 50)" }],
            claims: [{ logic: "autoApproved" }],
          },
        },
      }] as any,
    };

    const ctx = buildTaskContext(index, testCase);

    // R1 directly referenced, plus R2 via one-hop (shares 'amount' variable)
    expect(ctx.relevantRules.map((r) => r.ruleId)).toContain("R1");
    expect(ctx.relevantRules.map((r) => r.ruleId)).toContain("R2");

    // amount and autoApproved directly, plus requiresFinanceApproval via R2 expansion
    expect(ctx.relevantVariables.map((v) => v.name)).toContain("amount");
    expect(ctx.relevantVariables.map((v) => v.name)).toContain("autoApproved");
    expect(ctx.relevantVariables.map((v) => v.name)).toContain("requiresFinanceApproval");
  });

  it("includes document excerpts via fidelity grounding", () => {
    const def = makeDefinition();
    const sections = makeSections();
    const fidelity = makeFidelityReport();
    const index = buildContextIndex(def, "doc", sections, fidelity, []);

    const testCase: TestCaseWithResult = {
      testCase: { testCaseId: "tc1", guardContent: "test", expectedAggregatedFindingsResult: "VALID" },
      aggregatedTestFindingsResult: "SATISFIABLE",
      testFindings: [{
        valid: {
          supportingRules: [{ id: "R1" }],
          translation: { premises: [{ logic: "(= amount 50)" }], claims: [] },
        },
      }] as any,
    };

    const ctx = buildTaskContext(index, testCase);
    const sectionIds = ctx.relevantDocumentExcerpts.map((e) => e.sectionId);
    expect(sectionIds).toContain("s0-approval");
  });

  it("includes fidelity assessments for relevant rules", () => {
    const def = makeDefinition();
    const sections = makeSections();
    const fidelity = makeFidelityReport();
    const index = buildContextIndex(def, "doc", sections, fidelity, []);

    const testCase: TestCaseWithResult = {
      testCase: { testCaseId: "tc1", guardContent: "test", expectedAggregatedFindingsResult: "VALID" },
      aggregatedTestFindingsResult: "SATISFIABLE",
      testFindings: [{
        valid: {
          supportingRules: [{ id: "R1" }],
          translation: { premises: [], claims: [] },
        },
      }] as any,
    };

    const ctx = buildTaskContext(index, testCase);
    expect(ctx.relevantFidelity.ruleReports["R1"]).toBeDefined();
    expect(ctx.relevantFidelity.ruleReports["R1"].accuracyScore).toBe(1.0);
  });

  it("falls back to text search for NO_TRANSLATIONS (empty findings)", () => {
    const def = makeDefinition();
    const sections = makeSections();
    const index = buildContextIndex(def, "doc", sections, null, []);

    const testCase: TestCaseWithResult = {
      testCase: {
        testCaseId: "tc1",
        guardContent: "international travel expense",
        queryContent: "Does it need finance approval?",
        expectedAggregatedFindingsResult: "VALID",
      },
      aggregatedTestFindingsResult: "NO_TRANSLATIONS",
      testFindings: [],
    };

    const ctx = buildTaskContext(index, testCase);
    // Should find the "International Travel" section via text search
    const sectionIds = ctx.relevantDocumentExcerpts.map((e) => e.sectionId);
    expect(sectionIds).toContain("s1-international");
  });

  it("handles empty findings gracefully", () => {
    const def = makeDefinition();
    const index = buildContextIndex(def, null, [], null, []);

    const testCase: TestCaseWithResult = {
      testCase: { testCaseId: "tc1", guardContent: "", expectedAggregatedFindingsResult: "VALID" },
      aggregatedTestFindingsResult: "ERROR",
      testFindings: [],
    };

    const ctx = buildTaskContext(index, testCase);
    expect(ctx.relevantRules).toHaveLength(0);
    expect(ctx.relevantVariables).toHaveLength(0);
    expect(ctx.relevantDocumentExcerpts).toHaveLength(0);
  });
});

// ── estimateContextSize ──

describe("estimateContextSize", () => {
  it("estimates based on rule and variable counts", () => {
    const def = makeDefinition(); // 3 rules, 4 variables
    const size = estimateContextSize(def, null);
    // 3 * 200 + 4 * 250 = 1600
    expect(size).toBe(1600);
  });

  it("includes document text length", () => {
    const def = makeDefinition();
    const docText = "x".repeat(10000);
    const size = estimateContextSize(def, docText);
    expect(size).toBe(1600 + 10000);
  });

  it("includes type value counts", () => {
    const def = makeDefinition({
      types: [{ name: "Cat", description: "d", values: [{ value: "A", description: "a" }, { value: "B", description: "b" }] }],
    });
    const size = estimateContextSize(def, null);
    // 1600 (base) + 2 * 100 (type values)
    expect(size).toBe(1800);
  });

  it("returns 0 for empty definition and no document", () => {
    const def: PolicyDefinition = { version: "1.0", types: [], rules: [], variables: [] };
    expect(estimateContextSize(def, null)).toBe(0);
  });
});

describe("DEFAULT_COMPACT_THRESHOLD_BYTES", () => {
  it("is 100KB", () => {
    expect(DEFAULT_COMPACT_THRESHOLD_BYTES).toBe(100_000);
  });
});
