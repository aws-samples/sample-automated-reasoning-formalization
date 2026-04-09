/**
 * Tests for the CardRenderer component and individual card components.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { CardRenderer } from "./CardRenderer";
import type { ChatCard } from "../../types";

describe("CardRenderer", () => {
  const onAction = vi.fn();

  beforeEach(() => {
    onAction.mockClear();
  });

  it("renders a rule card with natural language and rule ID", () => {
    const card: ChatCard = {
      type: "rule",
      ruleId: "r1",
      naturalLanguage: "Employees must have 2 years of service",
      expression: "yearsOfService >= 2",
    };
    render(<CardRenderer card={card} onAction={onAction} />);
    expect(screen.getByText("Employees must have 2 years of service")).toBeTruthy();
    expect(screen.getByText("r1")).toBeTruthy();
  });

  it("renders a test card with humanized status", () => {
    const card: ChatCard = {
      type: "test",
      testId: "t1",
      answer: "Full-time employee",
      question: "Is this employee eligible?",
      expectedStatus: "VALID",
      actualStatus: "SATISFIABLE",
      findingsSummary: "Policy has partial coverage",
    };
    render(<CardRenderer card={card} onAction={onAction} />);
    expect(screen.getByText("Test found a mismatch")).toBeTruthy();
    expect(screen.getByText("Is this employee eligible?")).toBeTruthy();
    expect(screen.getByText(/Yes, confirmed by policy/)).toBeTruthy();
    expect(screen.getByText(/Possibly, but not guaranteed/)).toBeTruthy();
  });

  it("renders a proposal card with approve and reject buttons", () => {
    const card: ChatCard = {
      type: "proposal",
      title: "Add eligibility rule",
      description: "This will add a new rule",
      changes: [{ label: "Rule", before: "none", after: "yearsOfService >= 2" }],
      approvePrompt: "approve",
      rejectPrompt: "reject",
    };
    render(<CardRenderer card={card} onAction={onAction} />);
    expect(screen.getByText("Add eligibility rule")).toBeTruthy();
    expect(screen.getByText("Approve")).toBeTruthy();
    expect(screen.getByText("Reject")).toBeTruthy();
  });

  it("renders a next-steps card with action button", () => {
    const card: ChatCard = {
      type: "next-steps",
      summary: "Run all tests",
      description: "Execute the full test suite",
      prompt: "run tests",
    };
    render(<CardRenderer card={card} onAction={onAction} />);
    // "Run all tests" appears in both header and button
    expect(screen.getAllByText("Run all tests").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Execute the full test suite")).toBeTruthy();
  });

  it("renders a follow-up prompt card", () => {
    const card: ChatCard = {
      type: "follow-up-prompt",
      label: "Fix variable descriptions",
      prompt: "update variable descriptions",
    };
    render(<CardRenderer card={card} onAction={onAction} />);
    // Label appears in both header and button
    expect(screen.getAllByText("Fix variable descriptions").length).toBeGreaterThanOrEqual(1);
  });

  it("renders a variable-proposal card with input", () => {
    const card: ChatCard = {
      type: "variable-proposal",
      suggestedName: "yearsOfService",
      suggestedType: "Integer",
      suggestedLabel: "Years of employment",
    };
    render(<CardRenderer card={card} onAction={onAction} />);
    expect(screen.getByText(/yearsOfService/)).toBeTruthy();
    expect(screen.getByText(/Integer/)).toBeTruthy();
  });

  it("renders a guardrail-validation card with compliant status", () => {
    const card: ChatCard = {
      type: "guardrail-validation",
      compliant: true,
      llmResponse: "The policy is compliant",
      findings: [],
    };
    render(<CardRenderer card={card} onAction={onAction} />);
    expect(screen.getByText("Compliant")).toBeTruthy();
    expect(screen.getByText("The policy is compliant")).toBeTruthy();
  });

  it("renders a guardrail-validation card with non-compliant status and findings", () => {
    const card: ChatCard = {
      type: "guardrail-validation",
      compliant: false,
      llmResponse: "Issues found",
      findings: [{ ruleId: "r1", description: "Missing coverage" }],
    };
    render(<CardRenderer card={card} onAction={onAction} />);
    expect(screen.getByText("Not Compliant")).toBeTruthy();
  });

  it("renders unknown card type gracefully", () => {
    const card = { type: "unknown-type" } as unknown as ChatCard;
    render(<CardRenderer card={card} onAction={onAction} />);
    expect(screen.getByText("[Unknown card type]")).toBeTruthy();
  });
});
