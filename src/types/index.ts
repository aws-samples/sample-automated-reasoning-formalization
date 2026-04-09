import type {
  AutomatedReasoningPolicyTestCase,
  AutomatedReasoningPolicyTestResult,
  AutomatedReasoningCheckFinding,
  AutomatedReasoningCheckResult,
  AutomatedReasoningPolicyTestRunStatus,
  AutomatedReasoningPolicyTestRunResult,
  AutomatedReasoningPolicyBuildResultAssets,
} from "@aws-sdk/client-bedrock";

/** Fallback AWS region when AWS_REGION env var is not set. */
export const DEFAULT_AWS_REGION = "us-west-2";

// ── ACP session update types ──

/** Streamed update from the ACP agent during a prompt turn. */
export type AcpSessionUpdate =
  | AcpAgentMessageChunk
  | AcpToolCall
  | AcpToolResult
  | AcpToolCallUpdate;

export interface AcpAgentMessageChunk {
  sessionUpdate: 'agent_message_chunk';
  content?: { type?: string; text: string };
  sessionId?: string;
}

export interface AcpToolCall {
  sessionUpdate: 'tool_call';
  title: string;
  status: string;
  toolCallId: string;
  input?: unknown;
  arguments?: unknown;
  sessionId?: string;
}

export interface AcpToolResult {
  sessionUpdate: 'tool_result';
  toolCallId: string;
  content: unknown;
  status?: string;
  sessionId?: string;
}

export interface AcpToolCallUpdate {
  sessionUpdate: 'tool_call_update';
  title: string;
  status: string;
  toolCallId?: string;
  sessionId?: string;
}

// ── CLI error events (process-level, not session-level) ──

/** Discriminated union for Kiro CLI process-level errors forwarded from the main process. */
export type CliErrorEvent =
  | { type: 'stderr'; message: string }
  | { type: 'exit'; code: number | null };

// ── Policy types ──

export interface PolicyRule {
  ruleId: string;
  expression: string;
  description: string;
  sourceRef?: DocumentSourceRef;
}

export interface PolicyVariable {
  name: string;
  /** Built-in types: 'BOOL', 'INT', 'REAL'. Custom type names are also valid. */
  type: "BOOL" | "INT" | "REAL" | string;
  description: string;
  sourceRef?: DocumentSourceRef;
}

export interface PolicyType {
  name: string;
  description: string;
  values: { value: string; description: string }[];
}

export interface PolicyDefinition {
  version: string;
  types: PolicyType[];
  rules: PolicyRule[];
  variables: PolicyVariable[];
}

export interface PolicyMetadata {
  policyArn: string;
  policyVersionArn?: string;
  name: string;
  documentPath?: string;
  summarizedRules?: SummarizedSection[];
}

// ── Document types ──

export interface DocumentSourceRef {
  sectionIndex: number;
  ruleIndex: number;
  lineStart: number;
  lineEnd: number;
}

export interface SummarizedRule {
  naturalLanguage: string;
  sourceRef: DocumentSourceRef;
}

export interface SummarizedSection {
  sectionTitle: string;
  rules: SummarizedRule[];
}

// ── Chat types ──

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** @deprecated Use `cards` for multiple card support. Still read for backward compat. */
  card?: ChatCard;
  /** Zero or more cards embedded in this message. */
  cards?: ChatCard[];
  timestamp: number;
}

export type ChatCard =
  | RuleCard
  | TestCard
  | NextStepsCard
  | VariableProposalCard
  | GuardrailValidationCard
  | FollowUpPromptCard
  | ProposalCard;

// ── Rule card ──

export interface RuleCard {
  type: "rule";
  /** Unique rule identifier */
  ruleId: string;
  /** SMT-LIB formal logic expression */
  expression: string;
  /** Plain-language interpretation for non-technical users */
  naturalLanguage: string;
}

// ── Test card ──

export interface TestCard {
  type: "test";
  /** Test case identifier */
  testId: string;
  /** Guard content for the test (shown to the user as "Expected answer") */
  answer: string;
  /** Query content for the test (shown to the user as "Question") */
  question: string;
  /** What the user expected (VALID, SATISFIABLE, etc.) */
  expectedStatus: string;
  /** What the policy actually returned */
  actualStatus: string;
  /** Plain-language summary of the findings */
  findingsSummary: string;
}

// ── Next steps card ──

export interface NextStepsCard {
  type: "next-steps";
  /** One-sentence summary shown as a bold title */
  summary: string;
  /** Longer description shown in regular text */
  description: string;
  /** Prompt sent to the agent when the user clicks "Do it" */
  prompt: string;
}

export interface VariableProposalCard {
  type: "variable-proposal";
  suggestedName: string;
  suggestedLabel: string;
  suggestedType: string;
}

export interface GuardrailValidationCard {
  type: "guardrail-validation";
  llmResponse: string;
  compliant: boolean;
  findings: { ruleId: string; description: string }[];
}

export interface FollowUpPromptCard {
  type: "follow-up-prompt";
  /** Short label describing what the action will do */
  label: string;
  /** The prompt that will be sent to the agent when the user clicks "Do it" */
  prompt: string;
}

// ── Proposal card (approval gate for policy changes) ──

export interface ProposalCard {
  type: "proposal";
  /** Short title describing the proposed change */
  title: string;
  /** Plain-language description of what will change and why */
  description: string;
  /** The specific items being changed — rendered as a list */
  changes: { label: string; before?: string; after: string }[];
  /** Prompt sent to the agent when the user approves */
  approvePrompt: string;
  /** Prompt sent to the agent when the user rejects */
  rejectPrompt: string;
}

// ── Test panel types ──

/**
 * A test case merged with its latest execution result.
 * The test case fields are always present; result fields are optional
 * because a test may not have been run yet.
 */
export interface TestCaseWithResult {
  /** The underlying SDK test case */
  testCase: AutomatedReasoningPolicyTestCase;
  /** Result fields — present only if the test has been executed */
  testRunStatus?: AutomatedReasoningPolicyTestRunStatus;
  testRunResult?: AutomatedReasoningPolicyTestRunResult;
  testFindings?: AutomatedReasoningCheckFinding[];
  aggregatedTestFindingsResult?: AutomatedReasoningCheckResult;
  resultUpdatedAt?: Date;
}

// Re-export SDK types used across layers so consumers import from one place
export type {
  AutomatedReasoningPolicyTestCase,
  AutomatedReasoningPolicyTestResult,
  AutomatedReasoningCheckFinding,
  AutomatedReasoningCheckResult,
  AutomatedReasoningPolicyTestRunStatus,
  AutomatedReasoningPolicyTestRunResult,
};

// ── Build workflow types ──

// ── Build asset types ──

/**
 * A message generated during a build step.
 * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_AutomatedReasoningPolicyBuildStepMessage.html
 */
export interface BuildStepMessage {
  message: string;
  messageType: "INFO" | "WARNING" | "ERROR";
}

/**
 * A single step in the policy build process.
 * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_AutomatedReasoningPolicyBuildStep.html
 */
export interface BuildStep {
  context: Record<string, unknown>;
  messages: BuildStepMessage[];
  priorElement?: Record<string, unknown> | null;
}

/**
 * A single entry in the policy build log.
 * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_AutomatedReasoningPolicyBuildLogEntry.html
 */
export interface BuildLogEntry {
  annotation: Record<string, unknown>;
  buildSteps: BuildStep[];
  status: "APPLIED" | "FAILED";
}

export interface QualityReportIssue {
  issueType: "conflicting_rules" | "unused_variables" | "unused_type_values" | "disjoint_rule_sets" | string;
  description: string;
  affectedIds?: string[];
}

export interface BuildAssets {
  /** The build workflow ID these assets belong to */
  buildWorkflowId: string;
  /** Compiled policy definition from the build */
  policyDefinition: PolicyDefinition | null;
  /** Raw policy definition as returned by the SDK (for update calls) */
  rawPolicyDefinition: AutomatedReasoningPolicyBuildResultAssets | null;
  /** Build log entries */
  buildLog: BuildLogEntry[] | null;
  /** Raw build log asset from the API */
  rawBuildLog: AutomatedReasoningPolicyBuildResultAssets | null;
  /** Quality report issues */
  qualityReport: QualityReportIssue[] | null;
  /** Raw quality report asset from the API */
  rawQualityReport: AutomatedReasoningPolicyBuildResultAssets | null;
  /** Fidelity report mapping rules/variables to source document quotes */
  fidelityReport: FidelityReport | null;
  /** Raw fidelity report asset from the API */
  rawFidelityReport: AutomatedReasoningPolicyBuildResultAssets | null;
  /** Curated set of satisfiable policy scenarios */
  policyScenarios: PolicyScenario[] | null;
  /** Raw policy scenarios asset from the API */
  rawPolicyScenarios: AutomatedReasoningPolicyBuildResultAssets | null;
}


// ── Fidelity report types ──

export interface FidelityStatementLocation {
  lines: number[];
}

export interface FidelityAtomicStatement {
  id: string;
  text: string;
  location: FidelityStatementLocation;
}

export interface FidelityStatementReference {
  documentId: string;
  statementId: string;
}

export interface FidelityAnnotatedLine {
  lineNumber: number;
  lineText: string;
}

export interface FidelityAnnotatedChunk {
  pageNumber?: number;
  content: FidelityAnnotatedLine[];
}

export interface FidelityReportSourceDocument {
  documentName: string;
  documentHash: string;
  documentId: string;
  atomicStatements: FidelityAtomicStatement[];
  documentContent: FidelityAnnotatedChunk[];
}

// ── Policy scenario types ──

export interface PolicyScenario {
  /** Plain-language description of the scenario */
  alternateExpression: string;
  /** Expected result: VALID or SATISFIABLE */
  expectedResult: "VALID" | "SATISFIABLE" | string;
  /** SMT-LIB expression */
  expression: string;
  /** Rule IDs exercised by this scenario */
  ruleIds: string[];
}

export interface FidelityRuleReport {
  rule: string;
  groundingStatements?: FidelityStatementReference[];
  groundingJustifications?: string[];
  accuracyScore?: number;
  accuracyJustification?: string;
}

export interface FidelityVariableReport {
  policyVariable: string;
  groundingStatements?: FidelityStatementReference[];
  groundingJustifications?: string[];
  accuracyScore?: number;
  accuracyJustification?: string;
}

export interface FidelityReport {
  coverageScore: number;
  accuracyScore: number;
  ruleReports: Record<string, FidelityRuleReport>;
  variableReports: Record<string, FidelityVariableReport>;
  documentSources: FidelityReportSourceDocument[];
}


// ── Progressive import types ──

/** A section parsed from a markdown document by heading boundaries. */
export interface DocumentSection {
  /** Stable ID derived from heading level + index (e.g., "s0-introduction") */
  id: string;
  /** The heading text (e.g., "## Eligibility Criteria") */
  title: string;
  /** Heading level: 0 (preamble), 1, 2, or 3 */
  level: number;
  /** Start line (0-based, inclusive) in the original document */
  startLine: number;
  /** End line (0-based, exclusive) in the original document */
  endLine: number;
  /** The raw markdown text of this section (heading + body until next heading) */
  content: string;
}

/** Import status for a single document section. */
export type SectionImportStatus = "not_started" | "in_progress" | "completed" | "failed" | "timed_out";

/** Persisted state for a section's import workflow. */
export interface SectionImportState {
  sectionId: string;
  status: SectionImportStatus;
  /** Build workflow ID from the INGEST_CONTENT call, if started. */
  buildWorkflowId?: string;
  /** Timestamp of last status change. */
  lastUpdatedAt?: string;
  /** Instructions the user provided for this section's import. */
  instructions?: string;
}

/** Top-level persisted state for a policy's progressive import. */
export interface PolicyLocalState {
  policyArn: string;
  policyName: string;
  /** Path to the source markdown file on disk. */
  documentPath: string;
  /** Parsed section metadata (stable across app restarts). */
  sections: DocumentSection[];
  /** Import state per section, keyed by section ID. */
  sectionImports: Record<string, SectionImportState>;
  /** Fidelity reports keyed by build workflow ID. Only the latest is actively used. */
  fidelityReports: Record<string, FidelityReport>;
  /** The latest build workflow ID that completed successfully. */
  latestBuildWorkflowId?: string;
  /** The build workflow ID of the most recently applied fidelity report. */
  lastFidelityBuildWorkflowId?: string;
  /** Timestamp (ms since epoch) when the fidelity report was last applied. */
  lastFidelityReportTimestamp?: number;
  /** Curated policy scenarios from the latest build. */
  policyScenarios?: PolicyScenario[];
  /** Build workflow ID of the most recently cached scenarios. */
  lastScenariosBuildWorkflowId?: string;
}

