/**
 * Smoke tests for the test-scoped agent system prompt.
 */
import { describe, it, expect } from "vitest";
import { buildTestSystemPrompt } from "./test-system-prompt";

describe("buildTestSystemPrompt", () => {
  it("returns a non-empty string containing key sections", () => {
    const prompt = buildTestSystemPrompt();
    expect(prompt).toBeTruthy();
    expect(prompt).toContain("## RULES");
    expect(prompt).toContain("Root Cause Hierarchy");
    expect(prompt).toContain("REMINDER");
  });

  it("contains the diagnosis workflow", () => {
    const prompt = buildTestSystemPrompt();
    expect(prompt).toContain("Debugging Workflow");
    expect(prompt).toContain("check rules FIRST");
  });

  it("lists rule fixes before variable consolidation in root cause hierarchy", () => {
    const prompt = buildTestSystemPrompt();
    const hierarchy = prompt.slice(prompt.indexOf("Root Cause Hierarchy"));
    const rulesIdx = hierarchy.indexOf("Fix or add rules");
    const consolidateIdx = hierarchy.indexOf("Consolidate overlapping variables or improve descriptions");
    expect(rulesIdx).toBeGreaterThan(-1);
    expect(consolidateIdx).toBeGreaterThan(-1);
    expect(rulesIdx).toBeLessThan(consolidateIdx);
  });

  it("contains approval flow documentation", () => {
    const prompt = buildTestSystemPrompt();
    expect(prompt).toContain("APPROVAL_CODE");
    expect(prompt).toContain("proposal card");
    expect(prompt).toContain("Strategy selection is NOT approval");
  });

  it("contains implication direction guidance for SATISFIABLE", () => {
    const prompt = buildTestSystemPrompt();
    expect(prompt).toContain("wrong implication direction");
  });

  it("contains buildErrors checking guidance", () => {
    const prompt = buildTestSystemPrompt();
    expect(prompt).toContain("buildErrors");
  });
});
