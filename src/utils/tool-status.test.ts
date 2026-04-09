/**
 * Unit tests for tool status mapping.
 */
import { describe, it, expect } from "vitest";
import { friendlyToolStatus } from "./tool-status";

describe("friendlyToolStatus", () => {
  it('returns "Working…" for undefined title', () => {
    expect(friendlyToolStatus()).toBe("Working…");
    expect(friendlyToolStatus(undefined)).toBe("Working…");
  });

  it("maps MCP tool names to friendly messages", () => {
    expect(friendlyToolStatus("generate_fidelity_report")).toBe("Checking how well the rules match your document…");
    expect(friendlyToolStatus("add_rules")).toBe("Adding rules to policy…");
    expect(friendlyToolStatus("add_variables")).toBe("Adding variables to policy…");
    expect(friendlyToolStatus("update_variables")).toBe("Updating variable descriptions…");
    expect(friendlyToolStatus("execute_tests")).toBe("Running tests…");
  });

  it("maps Bedrock CLI commands to friendly messages", () => {
    expect(friendlyToolStatus("aws bedrock get-automated-reasoning-policy")).toBe("Loading policy…");
    expect(friendlyToolStatus("aws bedrock list-automated-reasoning-policies")).toBe("Listing policies…");
    expect(friendlyToolStatus("aws bedrock start-automated-reasoning-policy-build-workflow")).toBe("Starting build…");
  });

  it("falls back for unknown Bedrock commands", () => {
    const result = friendlyToolStatus("aws bedrock some-new-command");
    expect(result).toContain("some new command");
  });

  it("maps bash/shell tool calls", () => {
    expect(friendlyToolStatus("bash", "running")).toBe("Executing command…");
    expect(friendlyToolStatus("shell", "pending")).toBe("Preparing command…");
  });

  it('returns "Working…" for unknown tool names', () => {
    expect(friendlyToolStatus("some_random_tool")).toBe("Working…");
  });
});
