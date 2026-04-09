# ARchitect

A sample desktop application that helps non-technical subject matter experts (accountants, HR representatives, lawyers) formalize their documents into Automated Reasoning policies that can be used by [Automated Reasoning (AR) checks](https://aws.amazon.com/blogs/aws/minimize-ai-hallucinations-and-deliver-up-to-99-verification-accuracy-with-automated-reasoning-checks-now-available/) in Amazon Bedrock Guardrails. Behind the scences, ARchitect uses [Automated Reasoning checks' control plane APIs in Bedrock](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_Operations_Amazon_Bedrock.html) and [Kiro CLI](https://kiro.dev/cli/)'s Agent Client Protocol interface.

> [!IMPORTANT]
> ARchitect uses Anthropic Opus 4.6 through Kiro CLI to perform advanced reasoning about the source document, its formalization, and the results of policy tests. Your AWS account is charged for the use of Kiro CLI.

![ARchitect test repair through chat](/docs/screenshot_test_repair_chat.png)

ARchitect was developed using [Kiro IDE](https://kiro.dev/). This repository contains the definitions for three agents that collaborate to build new feature and improve the quality of the code and user experience.

## Prerequisites
Built with Electron, TypeScript, and the AWS SDK. Uses [Kiro's Agent Client Protocol](https://kiro.dev/docs/cli/acp/) for conversational AI.

- Node.js 18+
- npm
- AWS credentials configured (SSO or IAM) with access to Amazon Bedrock (see policy below)
- [Kiro CLI](https://kiro.dev/cli/) installed and on your PATH (required for the chat agent)

## IAM Permissions

ARchitect needs the following permissions to manage Automated Reasoning policies. Attach this policy to the IAM user or role whose credentials are configured in `~/.aws/credentials` (or via `AWS_PROFILE`).

Replace `REGION` and `ACCOUNT_ID` to match your environment.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AutomatedReasoningPolicyCRUD",
      "Effect": "Allow",
      "Action": [
        "bedrock:CreateAutomatedReasoningPolicy",
        "bedrock:GetAutomatedReasoningPolicy",
        "bedrock:UpdateAutomatedReasoningPolicy",
        "bedrock:DeleteAutomatedReasoningPolicy",
        "bedrock:ListAutomatedReasoningPolicies",
        "bedrock:ExportAutomatedReasoningPolicyVersion",
        "bedrock:CreateAutomatedReasoningPolicyVersion"
      ],
      "Resource": [
        "arn:aws:bedrock:REGION:ACCOUNT_ID:automated-reasoning-policy/*"
      ]
    },
    {
      "Sid": "AutomatedReasoningBuildWorkflows",
      "Effect": "Allow",
      "Action": [
        "bedrock:StartAutomatedReasoningPolicyBuildWorkflow",
        "bedrock:GetAutomatedReasoningPolicyBuildWorkflow",
        "bedrock:DeleteAutomatedReasoningPolicyBuildWorkflow",
        "bedrock:ListAutomatedReasoningPolicyBuildWorkflows",
        "bedrock:GetAutomatedReasoningPolicyBuildWorkflowResultAssets"
      ],
      "Resource": [
        "arn:aws:bedrock:REGION:ACCOUNT_ID:automated-reasoning-policy/*"
      ]
    },
    {
      "Sid": "AutomatedReasoningTestCases",
      "Effect": "Allow",
      "Action": [
        "bedrock:CreateAutomatedReasoningPolicyTestCase",
        "bedrock:GetAutomatedReasoningPolicyTestCase",
        "bedrock:UpdateAutomatedReasoningPolicyTestCase",
        "bedrock:DeleteAutomatedReasoningPolicyTestCase",
        "bedrock:ListAutomatedReasoningPolicyTestCases",
        "bedrock:StartAutomatedReasoningPolicyTestWorkflow",
        "bedrock:GetAutomatedReasoningPolicyTestResult",
        "bedrock:ListAutomatedReasoningPolicyTestResults"
      ],
      "Resource": [
        "arn:aws:bedrock:REGION:ACCOUNT_ID:automated-reasoning-policy/*"
      ]
    }
  ]
}
```

## Setup

```bash
# Clone the repo
git clone <repo-url> && cd ARchitect

# Install dependencies
npm install
```

## Running

```bash
# Start the app in development mode (hot-reload)
npm start

# Start with debug logging enabled
npm run start:debug
```

To aid in debugging, ARchitect also has the ability to export the state of a session. The feature is accessible in the `Help` menu in the `Download Debug Info` option. The `docs/debug-viewer.html` file helps visualize session JSON dumps. When reporting a bug in this repository, include either the (anonymized) debug log or session dump file.

By default, ARchitect uses `us-west-2`. You can change the region by setting the `AWS_REGION` environment variable.

## Development

To contribute to this repository, first configure your local clone to use the githooks commands by running the command below in the project root.

```bash
git config core.hooksPath .githooks
```

### Testing

```bash
# Run unit tests (single run)
npm test

# Run ACP integration tests (requires Kiro CLI)
npm run test:acp
```

### Building

```bash
# Package the app for the current platform
npm run package

# Create distributable installers
npm run make
```

### Linting

```bash
npm run lint
```

## Agent Benchmarks

Benchmarks measure the agent performance on policy repair tasks. Use them to detect prompt regressions before shipping changes to `agent-system-prompt.ts` or `test-system-prompt.ts`.

The benchmark creates an ephemeral policy with known deficiencies, asks the agent to fix failing tests through the normal conversational workflow, and produces an HTML report with convergence charts, per-test heatmaps, and an LLM-as-judge evaluation (Claude Opus 4.6).

```bash
# Run the full benchmark (~25-45 minutes)
npm run benchmark

# Skip the LLM judge for faster runs (~20-35 minutes)
BENCHMARK_SKIP_JUDGE=1 npm run benchmark

# Increase max repair iterations (default: 5)
BENCHMARK_MAX_ITERATIONS=10 npm run benchmark

# Clean up orphaned benchmark policies from crashed runs
npm run benchmark:cleanup
```

### Custom Fixtures

By default the benchmark uses the expense-policy fixtures in `benchmarks/fixtures/`. You can supply your own policy definition, source document, and test cases instead. All three must be provided together:

```bash
npm run benchmark -- \
  --policy-definition path/to/definition.json \
  --document path/to/document.md \
  --tests path/to/tests.json
```

The definition JSON must contain a top-level `policyDefinition` key, and the tests JSON must contain a `tests` array. See the files in `benchmarks/fixtures/` for the expected shape.

### Generating Reports from JSON

Each benchmark run writes a JSON companion file alongside the HTML report. You can regenerate the HTML from any JSON file — useful for sharing results or re-rendering after report template changes:

```bash
# Generate HTML from an existing benchmark JSON
npm run benchmark:generate-report -- --input benchmarks/reports/benchmark-2026-03-07.json

# Write to a custom output directory
npm run benchmark:generate-report -- --input results.json --output-dir ./my-reports
```

Prerequisites: same as running the app (Kiro CLI, AWS credentials), plus the MCP server bundle must exist at `.webpack/main/mcp-server.js` — run `npm start` once to generate it.

Reports are written to `benchmarks/reports/` as self-contained HTML files. See [`docs/example-benchmark-report.html`](docs/example-benchmark-report.html) for an example, and [`docs/agent-benchmark-design.md`](docs/agent-benchmark-design.md) for the full design.


To run the benchmark you need these additional IAM permissions:

```json
{
  "Sid": "BedrockInvokeModel",
  "Effect": "Allow",
  "Action": [
    "bedrock:InvokeModel"
  ],
  "Resource": [
    "arn:aws:bedrock:REGION::foundation-model/anthropic.*"
  ],
  "Condition": {
    "StringLike": {
      "bedrock:InvokedModelId": "anthropic.claude-*"
    }
  }
}
```
