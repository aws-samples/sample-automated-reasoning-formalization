/**
 * Map raw ACP tool_call titles to user-friendly status messages.
 * The user should never see internal tool names, ARNs, or CLI syntax.
 */
export function friendlyToolStatus(title?: string, status?: string): string {
  if (!title) return "Working…";

  // Policy workflow MCP tools → describe the operation
  const mcpToolMap: Record<string, string> = {
    "generate_fidelity_report": "Checking how well the rules match your document…",
    "add_rules": "Adding rules to policy…",
    "add_variables": "Adding variables to policy…",
    "update_variables": "Updating variable descriptions…",
    "execute_tests": "Running tests…",
  };
  if (mcpToolMap[title]) return mcpToolMap[title];

  // AWS Bedrock CLI commands → describe the operation
  const bedrockMatch = title.match(/^aws\s+bedrock\s+(.+)/i);
  if (bedrockMatch) {
    const cmd = bedrockMatch[1].trim().toLowerCase();
    const map: Record<string, string> = {
      "list-automated-reasoning-policy-test-cases": "Fetching test cases…",
      "list-automated-reasoning-policy-test-results": "Fetching test results…",
      "start-automated-reasoning-policy-test-workflow": "Running tests…",
      "get-automated-reasoning-policy-test-result": "Reading test results…",
      "create-automated-reasoning-policy-test-case": "Creating test case…",
      "update-automated-reasoning-policy-test-case": "Updating test case…",
      "delete-automated-reasoning-policy-test-case": "Deleting test case…",
      "get-automated-reasoning-policy": "Loading policy…",
      "update-automated-reasoning-policy": "Updating policy…",
      "list-automated-reasoning-policies": "Listing policies…",
      "start-automated-reasoning-policy-build-workflow": "Starting build…",
      "get-automated-reasoning-policy-build-workflow": "Checking build status…",
      "list-automated-reasoning-policy-build-workflows": "Checking builds…",
      "delete-automated-reasoning-policy-build-workflow": "Cleaning up old build…",
      "get-automated-reasoning-policy-build-workflow-result-assets": "Fetching build results…",
      "get-automated-reasoning-policy-next-scenario": "Generating test scenario…",
      "get-automated-reasoning-policy-annotations": "Reading annotations…",
      "create-automated-reasoning-policy-version": "Creating policy version…",
      "export-automated-reasoning-policy-version": "Exporting policy version…",
    };
    return map[cmd] ?? `Running: ${cmd.replace(/-/g, " ")}…`;
  }

  // Shell/bash tool calls (the agent executing commands)
  if (/bash|shell|exec/i.test(title)) {
    return status === "running" ? "Executing command…" : "Preparing command…";
  }

  // Fallback — don't expose raw tool names
  return "Working…";
}
