# Context Scaling: Retrieval-Based Agent Context for Large Policies

## Problem

The agent currently receives the full policy context on every conversational turn: the complete policy definition (rules, variables, types), the entire source document text, test cases, quality report, and satisfiable scenarios. This is assembled in `buildPolicyContext()` (`src/state/policy-state.ts`) and passed through `sendPolicyMessage()`.

For small policies (the expense policy benchmark fixture: 9 rules, 11 variables, ~16KB document), this works fine. For real-world policies derived from 100+ page documents, the context becomes unmanageable:

| Component | Small policy (BC Parks) | Large policy (100-page doc) |
|---|---|---|
| Source document | ~16 KB | 250–500 KB |
| Policy definition | ~57 KB (40 rules, 55 vars) | 200–400 KB (200+ rules, 150+ vars) |
| Fidelity report | ~121 KB | 500 KB – 1 MB |
| Test cases + results | ~5 KB | ~20–50 KB |
| **Total per turn** | **~200 KB** | **1–2 MB** |

At 1–2 MB per turn, the context window fills before the agent starts reasoning. Multi-turn repair conversations compound this — each turn re-sends the full context, leaving progressively less room for the agent's chain of thought.

## Goals

1. Keep per-turn context under ~50 KB for any policy size, without losing the agent's ability to diagnose and fix test failures.
2. Give the agent on-demand access to the full policy, document, and fidelity data through MCP tools.
3. Maintain backward compatibility — small policies should work exactly as they do today.
4. Support both the interactive UI and the benchmark harness.

## Non-Goals

- Changing the fidelity report generation or build workflow.
- Modifying the approval code flow or mutating tool definitions.
- Implementing semantic/vector search (simple text search + graph traversal is sufficient given the structured nature of the data).

## Design Overview

The solution has three layers:

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 1: Context Index (in-memory).                             │
│   Holds the full policy definition, source document, and        │
│   fidelity report. Never serialized to the agent.               │
├─────────────────────────────────────────────────────────────────┤
│ Layer 2: Compact Context (sent every turn)                      │
│   Structural outline + pre-selected context for the current     │
│   task. ~20–50 KB regardless of policy size.                    │
├─────────────────────────────────────────────────────────────────┤
│ Layer 3: MCP Search Tools (on-demand)                           │
│   Agent calls these to pull in additional context when the      │
│   compact context isn't enough.                                 │
└─────────────────────────────────────────────────────────────────┘
```


## Layer 1: Context Index

### Purpose

An in-memory data structure that holds the full policy data and provides fast lookup methods. Never serialized into agent context. The MCP search tools query it directly.

### Data Model

```typescript
// src/services/context-index.ts

interface ContextIndex {
  /** Full source document, split into sections. */
  documentSections: DocumentSection[];
  /** Full source document as raw text (for text search). */
  documentText: string;
  /** Full policy definition. */
  policyDefinition: PolicyDefinition;
  /** Fidelity report (may be null if not yet generated). */
  fidelityReport: FidelityReport | null;
  /** Test cases with latest results. */
  testCases: TestCaseWithResult[];

  // ── Derived indexes (built on load/update) ──

  /** Map: variable name → rule IDs that reference it in their expression. */
  variableToRules: Map<string, string[]>;
  /** Map: rule ID → variable names referenced in its expression. */
  ruleToVariables: Map<string, string[]>;
  /** Map: rule ID → document section IDs (via fidelity grounding statements). */
  ruleToSections: Map<string, string[]>;
  /** Map: variable name → document section IDs (via fidelity grounding). */
  variableToSections: Map<string, string[]>;
  /** Map: atomic statement ID → DocumentSection ID containing it. */
  statementToSection: Map<string, string>;

  // ── Availability flags ──

  /** Whether fidelity-derived edges are populated. */
  hasFidelityEdges: boolean;
  /** Whether fidelity data is stale (definition changed since last report). */
  fidelityStale: boolean;
}
```

### Incremental Construction

The index is built incrementally as data becomes available, not gated on any single artifact:

**Stage 1 — Definition-only** (available immediately on policy load):
- `policyDefinition` populated
- `variableToRules` and `ruleToVariables` derived by parsing SMT-LIB expressions
- `hasFidelityEdges = false`

**Stage 2 — Definition + document** (available when source document is loaded):
- `documentSections` and `documentText` populated
- `search_document` and `get_document_section` tools become functional

**Stage 3 — Full index** (available after fidelity report generation):
- `fidelityReport` populated
- `ruleToSections`, `variableToSections`, `statementToSection` derived from grounding statements
- `hasFidelityEdges = true`, `fidelityStale = false`

```typescript
function buildContextIndex(
  definition: PolicyDefinition,
  documentText: string | null,
  fidelityReport: FidelityReport | null,
  testCases: TestCaseWithResult[],
): ContextIndex;
```

The derived indexes are computed by:

1. **variableToRules / ruleToVariables**: Parse each rule's SMT-LIB expression and extract variable name references. A variable name appears in an expression if it matches a token in the S-expression that isn't a keyword (`=>`, `and`, `or`, `not`, `=`, `<`, `>`, `<=`, `>=`, `true`, `false`) and isn't a numeric literal.

2. **ruleToSections / variableToSections**: If a fidelity report exists, map each rule/variable's `groundingStatements[].statementId` → the atomic statement's `location.lines` → the `DocumentSection` whose `[startLine, endLine)` range contains those lines.

3. **statementToSection**: Invert the fidelity report's `documentSources[].atomicStatements` into a lookup from statement ID to the section containing it.

### Process Ownership

The MCP server subprocess (`mcp-server-entry.ts`) is stateless with respect to app state — it owns its own `PolicyService` and `PolicyWorkflowService` but has no access to the renderer's `policy-state.ts`, `buildAssetsStore`, fidelity reports, source document text, or test cases. This means the ContextIndex cannot live in the MCP subprocess directly.

**Solution: File-based index serialization** (same pattern as `APPROVAL_CODE_FILE`).

The renderer serializes the ContextIndex data to a temp file whenever the index is rebuilt. The MCP subprocess reads this file on demand when a search tool is called.

```
Renderer process:
  policy loaded / definition changed / fidelity report generated
    → buildContextIndex(...)
    → setContextIndex(index)                    // in-memory for renderer use
    → serializeContextIndex(index, filePath)    // atomic write to temp file

MCP subprocess (startup):
  → initContextIndexWatcher()                   // initial load + fs.watch on file

MCP subprocess (search tool called):
  → getContextIndex()                           // read from in-memory cache
  → execute query
  → return result

MCP subprocess (file change detected by fs.watch):
  → reload and deserialize into cachedIndex     // automatic, no tool call needed
```

The `CONTEXT_INDEX_FILE` path is passed to the MCP subprocess via environment variable, added to the MCP server config alongside `APPROVAL_CODE_FILE`:

```typescript
// In ChatSessionManager.getMcpServerConfig()
env: {
  AWS_REGION: "us-west-2",
  APPROVAL_CODE_FILE: approvalCodeFile,
  CONTEXT_INDEX_FILE: contextIndexFile,  // NEW
}
```

The file is written atomically (write to temp + rename) to avoid partial reads.

For the benchmark harness, the ContextIndex is passed in-process via `dispatchToolCall` — no file needed.

**Call chain per deployment mode:**

```
Benchmark:      runAgentLoop → dispatchToolCall(workflowService, contextIndex, ...)
Renderer:       renderer writes index file → MCP subprocess reads on demand
MCP subprocess: handleMcpRequest → dispatchToolCall(workflowService, loadedIndex, ...)
```

### Lifecycle and Invalidation

The index is rebuilt when:
- A policy is loaded (Stage 1, optionally Stage 2 if document is available).
- The source document is loaded or re-parsed (Stage 2).
- A fidelity report is generated (Stage 3).
- A mutating tool call completes (rebuild definition-derived edges, mark fidelity edges stale).

**Mutation invalidation** hooks into the existing `refreshTestsAfterPolicyChange` flow in `chat-message.ts`. After a mutation is detected (via the existing `policyWasUpdated` flag), the renderer re-exports the definition, rebuilds the definition-derived edges (`variableToRules`, `ruleToVariables`), and clears the fidelity-derived edges (`ruleToSections`, `variableToSections`), setting `fidelityStale = true`. The serialized file is rewritten.

**Known limitation — concurrent search + mutation**: If the agent issues a search tool call and a mutating tool call in the same turn (which the Kiro CLI may execute in parallel), search results could reflect pre-mutation state. This is acceptable for v1 — the compact context is always rebuilt from fresh state at the start of each turn, never cached across turns.

### Size Considerations

The index itself is lightweight — just Maps of string → string[]. The heavy data (document text, definition, fidelity report) is stored by reference in-memory and serialized to the file. For a 100-page policy, the serialized file is roughly the same size as the raw data (~1–2 MB). The MCP subprocess deserializes this once at startup and again only when the renderer rewrites the file, so the cost is amortized across all search tool calls within a session.


## Layer 2: Compact Context

### Purpose

Replace the current "send everything" approach in `buildPolicyContext()` with a two-part context that stays small regardless of policy size.

### Structure

The compact context has two parts:

#### Part A: Structural Outline (always sent)

A condensed view of the entire policy that lets the agent understand what exists without seeing the details. Target size: 5–15 KB even for policies with thousands of rules.

The key design constraint: policies can have 2,000+ rules and hundreds of variables. At ~100 chars per entry, a flat rule index would be 200+ KB — exceeding the entire context budget. The outline must therefore be hierarchical, grouping rules and variables by document section rather than enumerating them individually.

```typescript
interface PolicyOutline {
  policyArn: string;
  /** Signals to the agent that this is a compact context, not the full definition. */
  contextMode: 'compact';
  /** Total counts for orientation. */
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
  /**
   * Document table of contents with per-section rule/variable counts.
   * This is the primary navigation structure — the agent uses section IDs
   * to drill into specific areas via get_document_section, or to scope
   * searches via search_rules and search_variables.
   */
  documentOutline: {
    sectionId: string;
    title: string;
    level: number;
    startLine: number;
    endLine: number;
    /** Number of rules grounded in this section (from fidelity report). */
    groundedRuleCount: number;
    /** Number of variables grounded in this section. */
    groundedVariableCount: number;
    /** Import status if using progressive import. */
    importStatus?: SectionImportStatus;
  }[];
  /**
   * Variable type definitions (custom enum types). Included in full since
   * there are typically few types and they're needed to understand rule expressions.
   */
  typeDefinitions: PolicyType[];
  /** Quality report issues (already compact). */
  qualityIssues: QualityReportIssue[];
}
```

Note what's absent: there is no `ruleIndex` or `variableIndex` in the outline. For policies with thousands of rules, even a one-line-per-rule index is too large. Instead, the agent discovers rules and variables through:

1. **Task-relevant context** (Part B) — the rules and variables directly related to the current failing test are always included in full.
2. **Document outline** — the section-level rule/variable counts tell the agent where policy logic is concentrated, guiding search tool usage.
3. **Search tools** — `search_rules(query)` and `search_variables(query)` let the agent find specific rules/variables by keyword without enumerating all of them. `get_section_rules(sectionId)` returns all rules grounded in a specific document section.

This keeps the outline under 5 KB even for a 100-section document with 2,000+ rules.

#### Part B: Task-Relevant Context (pre-selected per turn)

When the agent is working on a specific failing test, the context assembly layer traces through the `ContextIndex` to pull in the relevant slice:

```typescript
interface TaskContext {
  /** The specific test case being analyzed (full detail). */
  targetTest: TestCaseWithResult;
  /** Rules directly involved in the test findings. */
  relevantRules: PolicyRule[];
  /** Variables referenced by those rules. */
  relevantVariables: PolicyVariable[];
  /** Document excerpts containing the grounding for those rules/variables. */
  relevantDocumentExcerpts: {
    sectionId: string;
    sectionTitle: string;
    /** Only the lines relevant to the grounding, with ±5 lines of context. */
    text: string;
    lineStart: number;
    lineEnd: number;
  }[];
  /** Fidelity assessments for the relevant rules/variables. */
  relevantFidelity: {
    ruleReports: Record<string, FidelityRuleReport>;
    variableReports: Record<string, FidelityVariableReport>;
  };
}
```

### Relevance Tracing Algorithm

Given a failing test, compute the task-relevant context:

```
1. Extract variable names from test findings:
   - findings[].translations[].variableName
   - findings[].untranslatedPremises / untranslatedClaims
   
2. Extract rule IDs from test findings:
   - findings[].supportingRules[].ruleId
   - findings[].contradictingRules[].ruleId

3. Expand via the context index graph:
   - For each variable → add all rules that reference it (variableToRules)
   - For each rule → add all variables it references (ruleToVariables)
   - (One hop only — don't transitively expand)

4. Map to document sections:
   - For each rule/variable → look up grounded sections (ruleToSections, variableToSections)
   - Extract the relevant line ranges from those sections

5. Collect fidelity assessments:
   - Pull ruleReports and variableReports for the collected IDs/names
```

For a typical single-test failure, this produces 3–10 rules, 5–15 variables, and 1–3 document excerpts — roughly 5–20 KB of task context.

### Fallback for Missing Signal

Some failure modes provide less signal for tracing:

| Failure Mode | Signal Available | Fallback Strategy |
|---|---|---|
| SATISFIABLE / VALID / INVALID | Rule IDs + variable names in findings | Standard tracing (above) |
| TRANSLATION_AMBIGUOUS | Variable names from partial translations | Trace variables → rules → sections |
| NO_TRANSLATIONS | Minimal — untranslated text only | Text-search the document for key terms from the test's guard/query content; include the top 3 matching sections |
| ERROR | None | Include only the test case; agent uses search tools |

For NO_TRANSLATIONS, the compact context builder performs a simple text search over `documentSections` using key terms extracted from the test's `guardContent` and `queryContent`. This is a basic substring/keyword match, not semantic search — sufficient because the test text typically uses domain terms that appear verbatim in the source document.

### API Changes

The compact context builder is a separate function from `buildPolicyContext`, accepting the target test explicitly to avoid hidden dependencies on global state:

```typescript
function buildCompactContext(
  contextIndex: ContextIndex,
  targetTest: TestCaseWithResult | null,
): { outline: PolicyOutline; taskContext: TaskContext | null };
```

`buildPolicyContext()` gains an optional `targetTest` parameter and selects the mode automatically:

```typescript
function buildPolicyContext(
  targetTest?: TestCaseWithResult,
): Record<string, unknown> | undefined;
```

- When the estimated context size is under `COMPACT_THRESHOLD_BYTES` (default: 100 KB, configurable via `ARCHITECT_COMPACT_THRESHOLD` env var): returns the full context as today.
- When over the threshold: calls `buildCompactContext` and returns the outline + task context.
- `ARCHITECT_CONTEXT_MODE=compact` env var forces compact mode regardless of size (for development/testing).

Call sites pass the target test explicitly:
- `chat-message.ts` (`createSendMessageHandler`): passes the currently selected test from `ChatSessionState`.
- `agent-loop.ts` (`buildFullPolicyContext`): passes the target test for the current iteration.
- Policy-level chat (no specific test selected): passes `undefined`, gets outline only without task context.

### Document Section Granularity

`parseMarkdownSections` splits on headings up to level 3. For documents with few headings, sections can exceed 10 KB, defeating the purpose of compact context.

A post-processing step subdivides sections exceeding 4 KB at paragraph boundaries (double-newline). Sub-sections get IDs like `s3-eligibility-p1`, `s3-eligibility-p2`. This is a pure utility function in `src/utils/markdown-sections.ts`.


## Layer 3: MCP Search Tools

### Purpose

Give the agent on-demand access to the full policy data when the compact context isn't enough. These are read-only tools — no approval code required.

### Graceful Degradation

The search tools work at any index stage, returning what's available:

- **Definition-only index**: `get_rule_details` and `get_variable_details` return definition data without fidelity grounding. `find_related_content` returns definition-derived connections only. `search_document` and `get_document_section` return "No source document loaded."
- **Definition + document index**: All tools work except fidelity grounding is absent. Results include a note: `"fidelityAvailable": false`.
- **Full index**: All tools return complete data including fidelity grounding, accuracy scores, and document section connections.
- **Stale fidelity**: Tools return the stale fidelity data with a `"fidelityStale": true` flag so the agent knows the grounding may not reflect recent mutations.

### Tool Definitions

Eight tools for querying the context index. All are read-only — no approval code required.

#### 1. `search_document`

Full-text search over the source document. Returns matching passages with surrounding context.

```typescript
{
  name: 'search_document',
  description:
    'Search the source document for passages matching a query. ' +
    'Returns matching lines with surrounding context and section information. ' +
    'Use this to find what the source document says about a specific topic.',
  inputSchema: {
    type: 'object',
    properties: {
      policyArn: { type: 'string', description: 'ARN of the policy' },
      query: {
        type: 'string',
        description: 'Search terms to find in the document. Matches are case-insensitive.',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of matching passages to return. Default: 5.',
      },
    },
    required: ['policyArn', 'query'],
  },
}
```

**Implementation**: Split the query into terms, scan each `DocumentSection`'s content for lines containing any term, score by term frequency, return the top N sections with the matching lines and ±5 lines of context. Each result includes `sectionId`, `sectionTitle`, `matchingText`, `lineStart`, `lineEnd`.

#### 2. `get_document_section`

Retrieve the full text of a specific document section by ID.

```typescript
{
  name: 'get_document_section',
  description:
    'Get the full text of a document section. Use the section IDs from the ' +
    'document outline in the policy context, or from search_document results.',
  inputSchema: {
    type: 'object',
    properties: {
      policyArn: { type: 'string' },
      sectionId: { type: 'string', description: 'Section ID from the document outline.' },
    },
    required: ['policyArn', 'sectionId'],
  },
}
```

**Implementation**: Look up the section in `contextIndex.documentSections`, return its full `content` field.

#### 3. `search_rules`

Search rules by keyword across their descriptions and expressions. This is the primary way the agent discovers rules in large policies — the outline does not enumerate individual rules.

```typescript
{
  name: 'search_rules',
  description:
    'Search policy rules by keyword. Matches against rule descriptions (natural language) ' +
    'and SMT-LIB expressions. Use this to find rules related to a specific concept ' +
    'when the policy has too many rules to list in context. ' +
    'Returns rule IDs, descriptions, and accuracy scores.',
  inputSchema: {
    type: 'object',
    properties: {
      policyArn: { type: 'string' },
      query: {
        type: 'string',
        description: 'Search terms to match against rule descriptions and expressions. Case-insensitive.',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of rules to return. Default: 10.',
      },
    },
    required: ['policyArn', 'query'],
  },
}
```

**Implementation**: Split query into terms, score each rule by term matches in its `description` and `expression` fields, return the top N. Each result includes `ruleId`, `description`, `expression`, `accuracyScore` (if available), and `referencedVariables` (from `ruleToVariables`).

#### 4. `search_variables`

Search variables by keyword across their names and descriptions.

```typescript
{
  name: 'search_variables',
  description:
    'Search policy variables by keyword. Matches against variable names and descriptions. ' +
    'Use this to find variables related to a specific concept. ' +
    'Returns variable names, types, descriptions, and accuracy scores.',
  inputSchema: {
    type: 'object',
    properties: {
      policyArn: { type: 'string' },
      query: {
        type: 'string',
        description: 'Search terms to match against variable names and descriptions. Case-insensitive.',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of variables to return. Default: 10.',
      },
    },
    required: ['policyArn', 'query'],
  },
}
```

**Implementation**: Split query into terms, score each variable by term matches in its `name` and `description` fields, return the top N. Each result includes the full `PolicyVariable` (name, type, description), `accuracyScore` (if available), and `referencedByRules` (from `variableToRules`).

#### 5. `get_section_rules`

Retrieve all rules and variables grounded in a specific document section. This is the section-scoped drill-down — the agent sees "Section 3 has 45 rules" in the outline and calls this to see what they are.

```typescript
{
  name: 'get_section_rules',
  description:
    'Get all rules and variables grounded in a specific document section. ' +
    'Use the section IDs from the document outline. ' +
    'Returns rules with their expressions and variables with their descriptions.',
  inputSchema: {
    type: 'object',
    properties: {
      policyArn: { type: 'string' },
      sectionId: { type: 'string', description: 'Section ID from the document outline.' },
    },
    required: ['policyArn', 'sectionId'],
  },
}
```

**Implementation**: Invert `ruleToSections` and `variableToSections` to find all rules/variables grounded in the given section. Return the full `PolicyRule` and `PolicyVariable` for each, plus fidelity reports if available. Cap at 50 rules and 50 variables per response to prevent context explosion on very dense sections.

#### 6. `get_rule_details`

Retrieve full details for one or more rules, including their SMT-LIB expressions, fidelity grounding, and related variables.

```typescript
{
  name: 'get_rule_details',
  description:
    'Get full details for specific rules including their SMT-LIB expressions, ' +
    'fidelity grounding (which document statements they formalize), accuracy scores, ' +
    'and which variables they reference. Use rule IDs from test findings, ' +
    'search_rules results, or get_section_rules results.',
  inputSchema: {
    type: 'object',
    properties: {
      policyArn: { type: 'string' },
      ruleIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Rule IDs to look up. Maximum 20.',
        maxItems: 20,
      },
    },
    required: ['policyArn', 'ruleIds'],
  },
}
```

**Implementation**: For each rule ID, return:
- The full `PolicyRule` (expression, description, sourceRef)
- The `FidelityRuleReport` if available (grounding statements, accuracy score, justification)
- The resolved grounding text (look up each `statementId` in the fidelity report's `atomicStatements` and return the statement text)
- The list of variable names referenced in the expression (from `ruleToVariables`)

#### 7. `get_variable_details`

Retrieve full details for one or more variables, including their descriptions, fidelity grounding, and which rules reference them.

```typescript
{
  name: 'get_variable_details',
  description:
    'Get full details for specific variables including their complete descriptions, ' +
    'fidelity grounding, accuracy scores, and which rules reference them. ' +
    'Use variable names from test findings, search_variables results, ' +
    'or get_section_rules results.',
  inputSchema: {
    type: 'object',
    properties: {
      policyArn: { type: 'string' },
      variableNames: {
        type: 'array',
        items: { type: 'string' },
        description: 'Variable names to look up. Maximum 20.',
        maxItems: 20,
      },
    },
    required: ['policyArn', 'variableNames'],
  },
}
```

**Implementation**: For each variable name, return:
- The full `PolicyVariable` (name, type, description)
- The `FidelityVariableReport` if available
- The resolved grounding text
- The list of rule IDs that reference this variable (from `variableToRules`)

#### 8. `find_related_content`

Graph traversal tool — given a rule or variable, find everything related to it.

```typescript
{
  name: 'find_related_content',
  description:
    'Given a rule ID or variable name, find all related content: ' +
    'connected rules, variables, document sections, and fidelity assessments. ' +
    'Use this to explore the policy graph when diagnosing a test failure ' +
    'that involves interconnected rules and variables.',
  inputSchema: {
    type: 'object',
    properties: {
      policyArn: { type: 'string' },
      ruleId: { type: 'string', description: 'A rule ID to start from (optional).' },
      variableName: { type: 'string', description: 'A variable name to start from (optional).' },
      depth: {
        type: 'number',
        description: 'How many hops to traverse. 1 = direct connections only. 2 = connections of connections. Default: 1. Maximum: 2.',
      },
    },
    required: ['policyArn'],
  },
}
```

**Implementation**: Starting from the given rule or variable, traverse the context index graph:
- Depth 1: rule → variables it references + sections it's grounded in; variable → rules that reference it + sections it's grounded in.
- Depth 2: expand each connected node one more hop.

Return a summary (not full details) of each connected node: rule IDs with descriptions, variable names with types, section IDs with titles. The agent can then call `get_rule_details` or `get_variable_details` for the ones it needs.

Cap the total response at 50 items to prevent explosion on highly connected policies.

### Tool Registration and Dispatch

The new tools are added to the `POLICY_TOOLS` array in `policy-mcp-server.ts` and dispatched in `dispatchToolCall()`. They don't require approval codes since they're read-only.

`dispatchToolCall` gains a `contextIndex` parameter:

```typescript
export async function dispatchToolCall(
  workflowService: PolicyWorkflowService,
  contextIndex: ContextIndex | null,
  toolName: string,
  args: Record<string, unknown>,
  logger?: (tag: string, ...args: unknown[]) => void,
): Promise<ToolCallResult>
```

This cascades to `handleMcpRequest` in `mcp-request-handler.ts`:

```typescript
export async function handleMcpRequest(
  req: McpRequest,
  workflowService: PolicyWorkflowService,
  contextIndex: ContextIndex | null,
  logger?: (tag: string, ...args: unknown[]) => void,
): Promise<McpResponse>
```

In the MCP subprocess (`mcp-server-entry.ts`), the context index is cached in memory and kept in sync with the file using `fs.watch`:

```typescript
let cachedIndex: ContextIndex | null = null;

function initContextIndexWatcher(): void {
  const filePath = process.env.CONTEXT_INDEX_FILE;
  if (!filePath) return;

  // Initial load
  cachedIndex = loadFromDisk(filePath);

  // Watch for changes — renderer rewrites the file after mutations,
  // fidelity report generation, or document reloads.
  fs.watch(filePath, () => {
    cachedIndex = loadFromDisk(filePath);
  });
}

function loadFromDisk(filePath: string): ContextIndex | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return deserializeContextIndex(JSON.parse(raw));
  } catch {
    return null;
  }
}

function getContextIndex(): ContextIndex | null {
  return cachedIndex;
}
```

`initContextIndexWatcher()` is called once at subprocess startup, alongside the `PolicyService` and `PolicyWorkflowService` initialization. Subsequent search tool calls read from `cachedIndex` with zero file I/O. The `fs.watch` callback fires when the renderer atomically rewrites the file (after mutations, fidelity report generation, or document reloads), keeping the cache fresh without polling.

In the benchmark harness, the context index is passed directly in-process — no file or watcher needed.

### Mutating Tool Response Compaction

Currently, `add_rules`, `add_variables`, etc. return the full `policyDefinition` in their response. For large policies, this is the same context overflow problem in reverse — the tool result consumes context.

When compact mode is active, mutating tools return a compact response instead:

```typescript
{
  buildWorkflowId: string;
  ruleCount: number;
  variableCount: number;
  changedItems: { type: 'rule' | 'variable'; id: string; action: 'added' | 'updated' | 'deleted' }[];
  buildErrors?: string[];
  buildLogSummary?: string;
}
```

The agent can use `get_rule_details` or `get_variable_details` to inspect the result if needed. Full mode continues to return the complete definition for backward compatibility.

The compact/full decision is signaled to the MCP subprocess via a `CONTEXT_MODE` environment variable (`full` or `compact`), set by the renderer based on the same size threshold used for context assembly.


## Agent Prompt Changes

### System Prompt Additions

Both `agent-system-prompt.ts` and `test-system-prompt.ts` need a new section explaining the search tools and when to use them:

```
## Context and Search Tools

The policy context you receive each turn includes a structural outline (document 
sections with per-section rule/variable counts) and pre-selected details for the 
current task. For large policies, this is a small subset of the full data — 
individual rules and variables are NOT listed in the outline.

When you need more detail, use these read-only search tools (no approval required):

- **search_document(query)** — Find passages in the source document matching your query.
- **get_document_section(sectionId)** — Get the full text of a document section.
- **search_rules(query)** — Find rules by keyword across descriptions and expressions.
- **search_variables(query)** — Find variables by keyword across names and descriptions.
- **get_section_rules(sectionId)** — Get all rules and variables grounded in a document section.
- **get_rule_details(ruleIds)** — Get full rule expressions, fidelity grounding, and related variables.
- **get_variable_details(variableNames)** — Get full variable descriptions, fidelity grounding, and related rules.
- **find_related_content(ruleId?, variableName?)** — Explore the policy graph to find connected rules, variables, and document sections.

Typical workflow for diagnosing a test failure:
1. Start with the pre-selected task context (rules/variables from test findings).
2. Use search_rules or search_variables to find related rules the task context may have missed.
3. Use get_document_section to read what the source document says about the relevant topic.
4. Use find_related_content to check for interconnected rules that might be affected by a fix.
5. Use get_rule_details or get_variable_details for full expressions before proposing changes.
```

### Compact Context Framing

When compact mode is active, the context includes a `contextMode: 'compact'` field and a preamble:

```
NOTE: This policy is large. You are seeing a structural outline and pre-selected 
context for the current task. Individual rules and variables are NOT listed in the 
outline — use the search tools (search_rules, search_variables, get_section_rules, 
search_document) to discover and inspect policy content as needed.
```

When `fidelityStale` is true, the context includes:

```
NOTE: The fidelity report is stale — the policy has been modified since the last 
report was generated. Fidelity grounding data may not reflect recent changes. 
Consider generating a new fidelity report if you need accurate grounding information.
```

## Benchmark Harness Changes

### `buildFullPolicyContext` Update

The benchmark's `buildFullPolicyContext()` in `agent-loop.ts` currently sends everything. It needs to:

1. Build a `ContextIndex` from the current policy state.
2. Use the same `buildCompactContext` function as the interactive UI.
3. Pass the `ContextIndex` directly to `dispatchToolCall` for search tool queries (in-process, no file I/O).

The target test for each iteration is already known (`targetTest` in the repair loop) and is passed to `buildCompactContext`.

### New Benchmark Metrics

The benchmark report should track search tool usage:

```typescript
interface SearchToolMetrics {
  /** Total search tool calls across all iterations. */
  totalSearchCalls: number;
  /** Breakdown by tool name. */
  callsByTool: Record<string, number>;
  /** Average response size (chars) for search tool results. */
  avgResponseSize: number;
  /** Whether the agent used search tools effectively (didn't re-request the same data). */
  duplicateSearchCalls: number;
}
```

This helps evaluate whether the agent is using the search tools efficiently or thrashing.

## Implementation Plan

### Phase 1: Context Index + Compact Context + Prompt Updates

Build the `ContextIndex`, the compact context builder, and the prompt updates as a single deliverable. Scope to the benchmark harness initially. Add `ARCHITECT_CONTEXT_MODE=compact` env var override for development testing.

The compact context and prompt updates must ship together — if the agent receives a `PolicyOutline` instead of a full `policyDefinition`, the prompts must explain the new format and the available search tools.

Files touched:
- `src/services/context-index.ts` (new — index construction, serialization, query methods)
- `src/state/policy-state.ts` (update `buildPolicyContext` with mode selection and `targetTest` parameter)
- `src/types/index.ts` (new interfaces: `PolicyOutline`, `TaskContext`)
- `src/utils/markdown-sections.ts` (add paragraph-level subdivision for large sections)
- `src/prompts/agent-system-prompt.ts` (add search tools section)
- `src/prompts/test-system-prompt.ts` (add search tools section)
- `src/utils/test-analysis.ts` (add compact context hints)
- `benchmarks/src/agent-loop.ts` (update `buildFullPolicyContext`)

### Phase 2: MCP Search Tools + Mutating Tool Compaction

Add the eight search tools to the MCP server. Wire `dispatchToolCall` and `handleMcpRequest` to accept a `ContextIndex`. Implement file-based index serialization for the MCP subprocess with `fs.watch`-based caching. Compact mutating tool responses when in compact mode.

Files touched:
- `src/services/policy-mcp-server.ts` (new tool definitions + dispatch cases + compact responses)
- `src/services/mcp-request-handler.ts` (add `contextIndex` parameter)
- `src/mcp-server-entry.ts` (load context index from file)
- `src/services/context-index.ts` (add `serializeContextIndex` / `deserializeContextIndex`)

### Phase 3: Interactive UI Integration

Enable compact mode in the interactive UI. Wire index serialization into the renderer's policy load and update flows. Hook index rebuild into `refreshTestsAfterPolicyChange`.

Files touched:
- `src/state/policy-state.ts` (add `setContextIndex` / `getContextIndex`, wire into `buildPolicyContext`)
- `src/workflows/chat-message.ts` (pass `targetTest` to `buildPolicyContext`, rebuild index after mutations)
- `src/workflows/policy-loader.ts` (build initial index on policy load)
- `src/services/chat-session-manager.ts` (add `CONTEXT_INDEX_FILE` to MCP server env)

### Phase 4: Benchmark Validation

Create a large-policy benchmark fixture (or adapt the BC Parks sample with inflated content) and run the full benchmark to validate:
- Agent converges with compact context + search tools.
- Search tool usage is efficient (low duplicate calls).
- Per-turn context stays under 50 KB.
- No regression on the small expense policy fixture.

Include a manual test protocol for the interactive UI path (renderer → MCP subprocess → search tool), since the benchmark exercises the in-process path only.

Files touched:
- `benchmarks/fixtures/` (new large fixture)
- `benchmarks/src/types.ts` (add `SearchToolMetrics`)
- `benchmarks/src/evaluation.ts` (track search tool metrics)
- `benchmarks/src/report-generator.ts` (render search tool metrics)

## Open Questions

1. **Threshold tuning**: The 100 KB default for `COMPACT_THRESHOLD_BYTES` is a starting estimate. Measure actual context window utilization with the Kiro CLI to find the right cutoff. The benchmark should log `JSON.stringify(context).length` for each turn. The right threshold is where the agent starts losing coherence — visible in the benchmark's convergence rate.

2. **Fidelity report dependency**: The search tools work without a fidelity report (they lose graph edges but retain definition lookup and text search). The `PolicyOutline.summary.fidelityAvailable` flag tells the agent whether fidelity data exists, so it can decide whether to generate a report before diving into diagnosis. No forced prerequisite.

3. **Cache invalidation granularity**: After mutations, definition-derived edges are rebuilt immediately but fidelity-derived edges are marked stale. The `fidelityStale` flag in the outline tells the agent the grounding may be outdated. Whether the agent should auto-regenerate the fidelity report after mutations is a prompt-level decision, not an architectural one.
