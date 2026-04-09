# ARchitect - Automated Reasoning policy editor
ARchitect is a desktop application that makes it easy for non-technical subject matter experts (SMEs), such as accountants, HR representatives, and lawyers, to ingest their documents and formalize them into Automated Reasoning policies that can be used by Automated Reasoning checks in Amazon Bedrock Guardrails. ARchitect is a user interface that relies on [Automated Reasoning checks' control plane APIs](https://docs.aws.amazon.com/bedrock/latest/userguide/kiro-cli-automated-reasoning-policy.html) and [Kiro's Agent Client Protocol APIs](https://kiro.dev/docs/cli/acp/) for conversational interfaces.

## Dependencies
* ARchitect is a TypeScript Electron app
* ARchitect uses the Automated Reasoning checks control plane APIs to manage policies — editing drafts and creating versioned copies when the user needs

## UI Structure

The UI follows a test-driven design with three panels. The layout prioritizes test exploration: users see all their tests at a glance, select one to investigate, and get a focused agent chat session scoped to that test. The document preview filters to show only the grounding relevant to the selected test.

### Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│  [Document Preview]   │  [Test Panel]         │  [Chat Panel]        │
│  (collapsible,        │  (collapsible,        │                      │
│   highlights filtered │   loads on policy     │  Scoped to selected  │
│   by selected test)   │   open)               │  test                │
│                       │                       │                      │
│  ┌─────────────────┐  │  ┌─────────────────┐  │  Agent: "This test   │
│  │ Highlighted rule │  │  │ ✓ Test 1        │  │  checks whether..."  │
│  │ grounding for    │  │  │ ✗ Test 2  ←sel  │  │                      │
│  │ selected test    │  │  │ ✓ Test 3        │  │  ┌────────────────┐  │
│  └─────────────────┘  │  │ ✗ Test 4        │  │  │ [Rule Card]    │  │
│                       │  │                 │  │  │ [Fix Suggest]  │  │
│                       │  └─────────────────┘  │  └────────────────┘  │
│                       │                       │                      │
│                       │                       │  [Chat Input]        │
└──────────────────────────────────────────────────────────────────────┘
```

### Three-panel workspace

#### Document preview panel (left, collapsible)
- Shows the content from the original source document
- Content is highlighted to show phrases that generated rules or variables (grounding highlights from the fidelity report)
- When a test is selected, the highlights filter to show only the rules relevant to that test:
  - Primary filter: highlights rules referenced in the test findings' `supportingRules` or `contradictingRules`
  - Fallback filter: when findings don't reference specific rules, highlights rules that operate on the variables assigned in the findings' translations (premises and claims)
- Clicking on a highlighted phrase brings up a popup showing the rule or variable
- The panel is collapsible to give more space to the test and chat panels

#### Test panel (center, collapsible)
- Loads automatically when a policy is opened — fetches all test cases and their latest execution results
- Each test is displayed as a list item showing:
  - Pass/fail status icon (✓/✗)
  - A short summary derived from the guard content (answer) and query content (question)
  - The expected vs actual result when they differ
- Selecting a test:
  1. Starts a new agent chat session scoped to that test
  2. Sends an automatic first prompt asking the agent to explain the test, why it's succeeding or failing, and whether there is untranslated content that should be translated
  3. Filters the document preview to highlight only the rules relevant to that test
- The panel is collapsible to give more space to the chat

#### Chat panel (right)
- Operates as a focused agent session scoped to the currently selected test
- When no test is selected, shows a prompt to select a test from the test panel
- When a test is selected, the chat session has full context of:
  - The test case details (guard content, query content, expected result)
  - The test execution result (actual result, findings, translations)
  - The policy definition (rules, variables, types) — for large policies, a compact outline with pre-selected task-relevant context (see [Context Scaling](./context-scaling-design.md))
  - The quality report (if available)
- The chat still supports the Policy and Playground mode toggle
- All existing card types and interactions remain functional within the scoped session

### Chat modalities

The chat panel operates in two distinct modes, toggled via a control at the top of the chat panel:

#### Policy mode (default)
The user converses with an AI assistant (via Kiro CLI ACP) that has full context of the policy and the selected test. In this mode the user can:
- Understand why a specific test is passing or failing
- Ask questions about the rules and variables involved in the test
- Request policy changes to fix failing tests
- Trigger the test-driven repair workflow
- Run the selected test again after making changes

All policy mutations flow through the chat. There is no separate rule builder form — the assistant proposes changes as interactive cards and the user confirms or refines them conversationally.

#### Playground mode
The user converses with an LLM (selectable from available Bedrock models) whose responses are validated by the policy via the `ApplyGuardrail` API. This mode lets SMEs experience the policy from an end-user perspective:
- Ask domain questions ("Am I eligible for a mortgage with a 650 credit score?")
- See the LLM's answer alongside the guardrail validation result
- Validation findings appear as rich cards showing which rules were triggered and whether the response was compliant

## Agent tools

The agent has access to policy workflow tools via MCP. These tools handle the full multi-step API workflows (build management, polling, cleanup) automatically.

### Policy mutation tools (require approval code)
- `add_rules` — Add one or more rules using SMT-LIB expressions
- `add_variables` — Add one or more variables to the policy
- `update_variables` — Update descriptions and optionally rename variables
- `delete_rules` — Delete one or more rules by ID
- `delete_variables` — Delete one or more variables by name
- `update_tests` — Update existing test cases
- `delete_tests` — Delete one or more test cases by ID

### Read-only tools (no approval required)
- `generate_fidelity_report` — Analyze policy coverage against source documents
- `execute_tests` — Run one or more test cases against the latest build

### Context search tools (no approval required)
For large policies, the agent receives a compact context outline instead of the full definition. These search tools give the agent on-demand access to the full policy data:
- `search_document` — Full-text search over the source document
- `get_document_section` — Retrieve full text of a document section
- `search_rules` — Search rules by keyword across descriptions and expressions
- `search_variables` — Search variables by keyword across names and descriptions
- `get_section_rules` — Get all rules/variables grounded in a document section
- `get_rule_details` — Get full details for specific rules
- `get_variable_details` — Get full details for specific variables
- `find_related_content` — Graph traversal to find connected rules, variables, and sections

See [Context Scaling Design](./context-scaling-design.md) for details on the compact context system.

## Initialization workflow
When the user opens the app, they choose to open an existing policy or create a new one.

### New policy
1. User provides a Markdown document as input
2. Application calls the agent to draft an instruction prompt for policy creation following documented best practices
3. Policy is created using Automated Reasoning checks' APIs with the document content passed via the INGEST_CONTENT build workflow
4. Assets from the policy creation are retrieved from the APIs
5. The document preview panel loads the Markdown content and highlights the lines that generated rules
6. The test panel is empty (no tests yet) — the chat suggests creating tests
7. The user is now in the main policy workspace with all three panels available

### Open existing policy
1. User selects a policy from the ones available in Automated Reasoning checks — loaded using the list API
2. Application prompts the user to load a local Markdown file as the source document for the policy
3. Application loads the document preview with the Markdown content
4. Application loads all test cases and their latest execution results into the test panel
5. The chat panel shows a prompt to select a test to begin investigating

## Document preview panel

The document preview is a persistent panel on the left side of the window:
- Shows the content from the original document
- Content is highlighted to show phrases that generated rules or variables
- Highlights update based on the selected test — when a test is selected, only the grounding relevant to that test is shown
- The panel is collapsible to give the other panels more space

### Test-driven highlight filtering

When a test is selected, the document preview filters its highlights using this logic:

1. Extract rule IDs from the test findings:
   - `supportingRules` from VALID/SATISFIABLE findings
   - `contradictingRules` from INVALID findings
2. If rule IDs are found, highlight only the grounding spans linked to those rules
3. If no rule IDs are found (e.g., TRANSLATION_AMBIGUOUS, NO_TRANSLATIONS), fall back to variable-based filtering:
   - Extract variable names from the findings' translations (premises and claims contain variable assignments)
   - Highlight grounding spans linked to rules that reference those variables
4. If no variables are found either, show all highlights (unfiltered)

## Test panel

The test panel is the primary navigation surface for the application:
- Loads test cases and results automatically when a policy is opened
- Displays tests as a scrollable list with pass/fail indicators
- Selecting a test drives the rest of the UI (chat session + document highlights)
- Supports refreshing test results after policy changes

## Rich message types

The chat uses specialized message types to display structured information inline. These are rendered as interactive cards within the chat timeline. The three primary card types below are the core of the user experience — the agent should use them proactively and frequently.

### Rule card (primary)
Displays a policy rule with a flippable interface:
- Front: the natural language interpretation of the rule, written for a non-technical user
- Back: the formal logic expression (SMT-LIB), accessible via a "Show formal logic" toggle
- Action: "Update rule" pre-populates the chat input with a templated prompt: `Rule [ID] says: "[natural language]" — this seems wrong because ` — letting the user complete the thought

### Test card (primary)
Displays a test result with Q&A format:
- Shows the answer (guard content) and question (query content)
- Pass/fail indicator with expected vs actual status
- Findings summary in plain language
- Actions: "Re-run test", "Dive deeper"

### Next steps card (primary)
Displays a suggested follow-up action:
- Bold summary line
- Description of what the action will do
- "Do it" button that sends a pre-built prompt to the agent

### Fix suggestion card
Displays multiple fix options as a radio-button list with an "Apply" button.

### Variable proposal card
Displays a suggested new variable with editable name field and accept/reject buttons.

### Guardrail validation card
Displays playground mode validation results with compliant/non-compliant status and expandable findings.

### Follow-up prompt card
Displays a simple one-click action button that sends a prompt to the agent.
