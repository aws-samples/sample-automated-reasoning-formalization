# Event Flow Documentation

This document traces how events flow across processes, services, workflows, and UI components in the ARchitect application. Use these diagrams to understand the wiring before making changes.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Module Responsibilities](#module-responsibilities)
- [Process Boundary (IPC)](#process-boundary-ipc)
- [Agent Stream Pattern](#agent-stream-pattern)
- [Chat Message Flow](#chat-message-flow)
- [Streaming & Card Rendering](#streaming--card-rendering)
- [Card Action Dispatch](#card-action-dispatch)
- [New Policy Creation](#new-policy-creation)
- [Open Existing Policy](#open-existing-policy)
- [Progressive Section Import](#progressive-section-import)
- [Build Workflow Monitoring](#build-workflow-monitoring)
- [Fidelity Report Flow](#fidelity-report-flow)
- [Test Panel Interactions](#test-panel-interactions)
- [Test Chat Session Lifecycle](#test-chat-session-lifecycle)
- [Document Preview Interactions](#document-preview-interactions)
- [Policy Update Detection](#policy-update-detection)
- [MCP Server Subprocess](#mcp-server-subprocess)
- [Callback Wiring Summary](#callback-wiring-summary)
- [Debug Logging & Export](#debug-logging--export)

---

## Architecture Overview

The application uses a hybrid architecture: `renderer.ts` is the composition root
for service instantiation and event wiring, while `App.tsx` is the React root
component managing screens and modals. Two imperative bridge handles
(`window.__appHandle` and `window.__workspaceLayout`) allow the legacy composition
root to drive React state during the ongoing Cloudscape migration.

> **Migration note:** The `__appHandle` and `__workspaceLayout` bridges are
> temporary artifacts. Remove them when all workflows use React state/routing
> directly. Call sites that depend on `__appHandle`: `handleCreatePolicy`,
> `handleOpenPolicy`, `handlePolicySelected`, `showScreen`, and the
> `SectionImportDialog` bridge.

```
Main Process (Node.js)          Preload Bridge          Renderer Process (Browser)
┌─────────────────────┐    ┌──────────────────┐    ┌──────────────────────────────────────┐
│ main.ts             │    │ preload.ts        │    │ App.tsx (React Root)                 │
│ AcpClient           │◄──►│ window.architect  │◄──►│   ├── LandingScreen                  │
│ File System         │    │ API               │    │   ├── BuildingScreen                  │
│ Kiro CLI subprocess │    └──────────────────┘    │   ├── WorkspaceLayout                 │
│                     │                            │   │   ├── DocumentPreviewPanel         │
│ MCP Server          │                            │   │   ├── TestPanel                    │
│ (separate process)  │                            │   │   └── ChatPanelComponent           │
│ mcp-server-entry.ts │                            │   ├── PolicyPickerModal                │
│ PolicyWorkflowSvc   │                            │   ├── NewPolicyModal                   │
└─────────────────────┘                            │   └── SectionImportModal               │
                                                   │                                        │
                                                   │ renderer.ts (Composition Root)         │
                                                   │   ├── ChatSessionManager               │
                                                   │   ├── BuildOrchestrator                │
                                                   │   ├── PolicyService                    │
                                                   │   │                                    │
                                                   │   ├── Workflows                        │
                                                   │   │   ├── policy-loader.ts             │
                                                   │   │   ├── test-workflows.ts            │
                                                   │   │   ├── section-import.ts            │
                                                   │   │   ├── chat-message.ts              │
                                                   │   │   ├── section-wiring.ts            │
                                                   │   │   └── card-actions.ts              │
                                                   │   │                                    │
                                                   │   ├── Services                         │
                                                   │   │   ├── chat-service.ts              │
                                                   │   │   ├── chat-context-router.ts       │
                                                   │   │   ├── context-index.ts             │
                                                   │   │   ├── fidelity-workflow.ts         │
                                                   │   │   └── build-assets-store.ts        │
                                                   │   │                                    │
                                                   │   ├── State                            │
                                                   │   │   └── policy-state.ts              │
                                                   │   │                                    │
                                                   │   ├── Contexts                         │
                                                   │   │   └── ServiceContext.tsx            │
                                                   │   │                                    │
                                                   │   └── Utils                            │
                                                   │       ├── agent-stream.ts              │
                                                   │       └── stream-parser.ts             │
                                                   └──────────────────────────────────────┘
```

---

## Module Responsibilities

| Module | Location | Responsibility |
|--------|----------|----------------|
| `renderer.ts` | Composition root | Service/component instantiation, event wiring, `handleNewPolicy`, `handleOpenPolicy`, `onSendMessage` handler |
| `App.tsx` | React root | Screen router (`landing \| building \| workspace`), modal host, imperative `AppHandle` bridge to `renderer.ts` |
| `WorkspaceLayout.tsx` | `src/components/` | Three-panel workspace layout (doc preview, test panel, chat), exposes `__workspaceLayout` toggle handle |
| `ServiceContext.tsx` | `src/contexts/` | React context provider for `{ policyService, buildOrchestrator, chatSessionMgr }` |
| `policy-state.ts` | `src/state/` | Centralized app state (8 state variables including `contextIndex`), persistence helpers, derived state accessors, compact context builder (`buildPolicyContext` with optional `targetTest` parameter) |
| `BuildOrchestrator` | `src/services/` | Build asset loading, fidelity report management, background polling |
| `ChatSessionManager` | `src/services/` | Chat session lifecycle, MCP config, session caching, history persistence, test chat sessions |
| `section-import.ts` | `src/workflows/` | Progressive document import orchestration (`importSection`, `importMultipleSections`, `executeSectionImport`) |
| `chat-message.ts` | `src/workflows/` | Chat message send handler (`createSendMessageHandler`), uses `installStreamHandler` for streaming |
| `section-wiring.ts` | `src/workflows/` | Section import callback wiring for DocumentPreview (`wireSectionHandlers`) |
| `PolicyService` | `src/services/` | Bedrock SDK wrapper (CRUD, builds, tests, scenarios, build slot management) |
| `PolicyWorkflowService` | `src/services/` | Deterministic policy workflows (REFINE_POLICY, test execution via MCP tools) |
| `ChatService` | `src/services/` | Kiro CLI ACP integration (chat, summarization, card extraction) |
| `policy-loader.ts` | `src/workflows/` | `loadPolicy` orchestration (definition export, metadata, progressive import recovery, build assets, agent greeting) |
| `test-workflows.ts` | `src/workflows/` | Test panel event handlers, `refreshTestsAfterPolicyChange`, test analysis prompts, highlight filter computation |
| `card-actions.ts` | `src/workflows/` | Card action dispatch (`createCardActionHandler`) |
| `agent-stream.ts` | `src/utils/` | Shared streaming utility: `installStreamHandler` (save/set/restore pattern) and `streamAgentMessage` (fire-and-forget). Used across 4 call sites |
| `useStreamProcessor.ts` | `src/hooks/` | React hook for incremental chat stream processing, card boundary detection, stable segment keys |
| `useCliErrors.ts` | `src/hooks/` | React hook for CLI error notifications via `acp:cli-error` IPC channel |
| `approval-code-store.ts` | `src/services/` | Shared Node.js module for approval code write/consume. Used by main process (write via IPC) and MCP server subprocess (consume during tool dispatch) |
| `mcp-server-entry.ts` | `src/` | Standalone MCP server entry point (stdio JSON-RPC). Spawned by Kiro CLI, owns its own `PolicyService` + `PolicyWorkflowService` instances |
| `mcp-request-handler.ts` | `src/services/` | MCP JSON-RPC request routing (`initialize`, `tools/list`, `tools/call`) |
| `policy-mcp-server.ts` | `src/services/` | MCP tool definitions (`POLICY_TOOLS` + `SEARCH_TOOLS`) and `dispatchToolCall` — dispatches to `PolicyWorkflowService` methods and context index search functions |
| `context-index.ts` | `src/services/` | In-memory context index over policy data. Holds definition, document, fidelity report, and derived lookup maps. Provides search functions (`searchDocument`, `searchRules`, `searchVariables`, `getSectionRules`, `getRuleDetails`, `getVariableDetails`, `findRelatedContent`), compact context builder (`buildPolicyOutline`, `buildTaskContext`), and serialization for MCP subprocess IPC |
| `chat-context-router.ts` | `src/services/` | Per-context chat state multiplexer. Maintains separate segment arrays and stream state per chat context (policy vs test), preventing message leakage during context switches. Used by `ChatPanelComponent` |
| `fidelity-workflow.ts` | `src/services/` | Shared fidelity report build workflow (`runFidelityBuildWorkflow`). Encapsulates ensure-slot → start-build → poll → fetch-asset → parse. Used by both `BuildOrchestrator` (UI-facing) and `PolicyWorkflowService` (MCP-facing) |
| `stream-parser.ts` | `src/utils/` | Pure function for detecting card boundaries in raw streamed text. Extracted from `useStreamProcessor` so it can be shared by `ChatContextRouter` |
| `debug-logger.ts` | `src/services/` | Structured JSON-lines logger for the main process. Writes to `~/.ARchitect/logs/debug.jsonl` with automatic rotation. Taps existing ACP event streams |
| `debug-snapshot.ts` | `src/utils/` | Builds a sanitized state snapshot for the debug export. Renderer-side only, reads from `policy-state.ts` getters |

### Dependency Injection Pattern

Orchestrator services and workflows accept UI dependencies through callback interfaces, not direct component imports. This keeps them testable:

- `BuildOrchestrator` receives `BuildOrchestratorUI` + `BuildOrchestratorState`
- `ChatSessionManager` receives `ChatSessionUI` + `ChatSessionState`
- `wireTestPanelHandlers` receives `TestWorkflowDeps`
- `loadPolicy` receives `PolicyLoaderDeps`
- `importSection` / `importMultipleSections` receive `SectionImportDeps`
- `createCardActionHandler` receives `CardActionDeps`
- `createSendMessageHandler` receives `ChatMessageDeps`

All dependency bags are constructed in `renderer.ts` (the composition root).

---

## Process Boundary (IPC)

All communication between main and renderer goes through the preload bridge. The renderer never accesses Node.js APIs directly.

```mermaid
sequenceDiagram
    participant R as Renderer
    participant P as Preload Bridge
    participant M as Main Process
    participant K as Kiro CLI

    Note over P: window.architect API

    R->>P: acpStart(cwd)
    P->>M: ipcRenderer.invoke("acp:start")
    M->>K: spawn kiro-cli acp
    K-->>M: initialize handshake
    M-->>P: resolved
    P-->>R: resolved

    R->>P: acpCreateSession(cwd, systemPrompt)
    P->>M: ipcRenderer.invoke("acp:createSession")
    M->>K: session/new + session/set_model
    K-->>M: { sessionId }
    M-->>R: sessionId

    R->>P: acpSendPrompt(text, sessionId)
    P->>M: ipcRenderer.invoke("acp:sendPrompt")
    M->>K: session/prompt

    loop Streaming
        K-->>M: session/update notification
        M-->>R: ipcRenderer.on("acp:session-update")
    end

    K-->>M: prompt complete
    M-->>R: { stopReason }
```

### IPC Channel Map

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `dialog:openFile` | R → M | Open PDF/TXT file picker |
| `dialog:openMarkdown` | R → M | Open markdown file picker |
| `dialog:saveFile` | R → M | Save file dialog |
| `file:readBase64` | R → M | Read file as base64 |
| `file:readText` | R → M | Read file as UTF-8 text |
| `metadata:save` | R → M | Persist policy metadata to disk |
| `metadata:load` | R → M | Load policy metadata from disk |
| `localState:save` | R → M | Persist progressive import state |
| `localState:load` | R → M | Load progressive import state |
| `localState:saveFidelityReport` | R → M | Cache fidelity report to disk |
| `localState:loadFidelityReport` | R → M | Load cached fidelity report |
| `localState:saveScenarios` | R → M | Persist policy scenarios to disk |
| `localState:loadScenarios` | R → M | Load policy scenarios from disk |
| `chatHistory:save` | R → M | Persist chat conversation HTML |
| `chatHistory:load` | R → M | Load chat conversation HTML |
| `aws:getCredentials` | R → M | Get AWS credentials from INI profile |
| `mcp:serverPath` | R → M | Get path to MCP server entry point |
| `approval:getFilePath` | R → M | Get approval code file path |
| `approval:writeCode` | R → M | Write approval code to file |
| `acp:start` | R → M | Spawn Kiro CLI subprocess |
| `acp:createSession` | R → M | Create ACP agent session |
| `acp:sendPrompt` | R → M | Send prompt to agent |
| `acp:cancel` | R → M (fire-and-forget) | Cancel current prompt turn |
| `acp:stop` | R → M (fire-and-forget) | Kill Kiro CLI subprocess |
| `acp:session-update` | M → R | Streamed agent updates (text chunks, tool calls, tool results) |
| `acp:cli-error` | M → R | CLI process-level errors. Payload: `CliErrorEvent { type: 'stderr' \| 'exit', message?: string, code?: number }` |
| `debug:requestExport` | M → R | Menu trigger for debug export (Help → Download Debug Info) |
| `debug:export` | R → M | Export debug info — renderer sends state snapshot, main combines with logs and saves |

---

## Agent Stream Pattern

The `agent-stream.ts` utility encapsulates the save-handler / set-handler / stream / restore-handler pattern used across multiple workflows. It provides two variants:

### `installStreamHandler` (caller-managed lifecycle)

Used when the caller needs to control the send lifecycle (e.g. in-flight prompt tracking, interruption support). Used by `chat-message.ts`.

```
1. Save previous onUpdate handler
2. Install new dispatcher that routes by sessionUpdate type:
   - agent_message_chunk → pushStreamChunk + onMessageChunk
   - tool_call → noteToolCallStarted + noteToolActivity + onToolCall (with logging)
   - tool_result → onToolResult (with error detection)
3. Chain: new handler calls previousHandler?.(update) at the end
4. Return { previousHandler, restore() }
5. Caller calls restore() in finally block
```

### `streamAgentMessage` (fire-and-forget)

Used when the caller just needs to stream a prompt and collect the response. Handles the full lifecycle internally. Used by `policy-loader.ts`, `section-import.ts`, and `chat-session-manager.ts`.

```
1. Calls installStreamHandler internally
2. Calls chatService.sendPolicyMessage(prompt, context)
3. Calls restore() in finally block
```

Both variants accept `StreamCallbacks` (the UI contract) and `StreamOptions` (log prefix).

---

## Chat Message Flow

Shows how a user message travels from the input field through the agent and back to the UI. The `onSendMessage` handler is created by `createSendMessageHandler` in `chat-message.ts` and uses `installStreamHandler` from `agent-stream.ts` for the streaming pattern.

```mermaid
sequenceDiagram
    participant U as User
    participant CP as ChatPanelComponent
    participant CMW as chat-message.ts
    participant CSM as ChatSessionManager
    participant AS as agent-stream.ts
    participant CS as ChatService
    participant T as IpcAcpTransport
    participant M as Main Process
    participant K as Kiro CLI Agent

    U->>CP: Types message, presses Enter
    CP->>CMW: onSendMessage(text)

    CMW->>CSM: activeChatService()
    CSM-->>CMW: policy or test ChatService
    CMW->>CSM: cancelActivePrompt()
    CMW->>CP: appendStatus("Thinking…")
    CMW->>CP: startStreaming()

    CMW->>AS: installStreamHandler(chatService, callbacks)
    AS-->>CMW: { previousHandler, restore }
    CMW->>CSM: Register inFlightPrompt { chatService, statusEl, streamAnchor, previousHandler }

    CMW->>CS: sendPolicyMessage(message, policyContext)
    CS->>T: sendPrompt(fullPrompt, sessionId)
    T->>M: ipcRenderer.invoke("acp:sendPrompt")
    M->>K: session/prompt (JSON-RPC)

    loop Agent Streaming
        K-->>M: session/update (agent_message_chunk)
        M-->>AS: forwarded via onUpdate dispatcher
        AS->>CP: pushStreamChunk(text)
        AS->>CP: updateStatus("Responding…")
    end

    loop Tool Calls
        K-->>M: session/update (tool_call)
        M-->>AS: forwarded via onUpdate dispatcher
        AS->>CP: updateStatus(friendlyToolStatus())
        AS->>CP: noteToolCallStarted()
        AS->>CP: noteToolActivity(friendlyLabel)        Note over AS: Detects policy update via title string match:<br/>info.title.includes('update-automated-reasoning-policy')
    end

    K-->>M: prompt complete
    CS-->>CMW: returns ChatMessage
    CMW->>AS: restore() [in finally block]
    CMW->>CP: endStreaming()
    CMW->>CSM: saveChatHistoryToDisk(chatId)
    CMW->>CMW: Check policyWasUpdated → refreshTestsAfterPolicyChange()
```

### Prompt Interruption

When the user sends a follow-up message while a prompt is in-flight, `cancelActivePrompt()` at the top of the handler:
1. Checks `chatSessionMgr.inFlightPrompt`
2. Aborts the streaming UI (`abortStreaming`)
3. Restores the previous `onUpdate` handler
4. Rejects the pending ACP request

This allows overlapping messages without corrupted UI state.

---

## Streaming & Card Rendering

The `useStreamProcessor` hook in `src/hooks/useStreamProcessor.ts` processes streamed text incrementally, detecting card boundaries (JSON fenced blocks and XML `<card>` tags) in real time. It produces a `ChatSegment[]` list with stable IDs so React doesn't re-render already-committed segments.

### Known Card Types

| Type | Component | Source File |
|------|-----------|-------------|
| `rule` | `RuleCard` | `cards/RuleCard.tsx` |
| `test` | `TestCard` | `cards/TestCard.tsx` |
| `next-steps` | `PromptActionCard` (variant: `next-step`) | `cards/PromptActionCard.tsx` |
| `follow-up-prompt` | `PromptActionCard` (variant: `suggestion`) | `cards/PromptActionCard.tsx` |
| `variable-proposal` | `VariableProposalCard` | `cards/VariableProposalCard.tsx` |
| `guardrail-validation` | `GuardrailValidationCard` | `cards/GuardrailValidationCard.tsx` |
| `proposal` | `ProposalCard` | `cards/ProposalCard.tsx` |

Card type dispatch is handled by `CardRenderer.tsx`, which switches on `card.type` and renders the appropriate component.

---

## Card Action Dispatch

Cards emit actions via callbacks. The `createCardActionHandler` in `src/workflows/card-actions.ts` routes them. It receives `CardActionDeps` (chatPanel, docPreview, state accessors) via dependency injection from `renderer.ts`.

```mermaid
flowchart TD
    Card[Card Button Click] --> OnAction["onAction(action, data)"]
    OnAction --> CP["ChatPanelComponent.onCardAction(cardType, action, data)"]
    CP --> Handler["createCardActionHandler (card-actions.ts)"]
    Handler --> Router{cardType + action}

    Router -->|rule + update-rule| Prefill[chatPanel.prefillInput]
    Router -->|rule + show-source| Emphasize[docPreview.emphasize]
    Router -->|any + filter-entity| Filter[docPreview.filterByEntity]
    Router -->|test + rerun-test| Rerun[onSendMessage with re-run prompt]
    Router -->|test + dive-deeper| Dive[onSendMessage with deep analysis prompt]
    Router -->|next-steps + execute-prompt| ExecNS[onSendMessage]
    Router -->|follow-up-prompt + execute-prompt| ExecFP[onSendMessage]
    Router -->|variable-proposal + accept-variable| Accept[onSendMessage: Add variable]
    Router -->|guardrail-validation + highlight-rule| Highlight[docPreview.emphasize]
    Router -->|proposal + approve| Approve[writeApprovalCode + onSendMessage with code]
    Router -->|proposal + reject| Reject[onSendMessage]
```

Dismissable card types (`follow-up-prompt`, `next-steps`, `proposal`, `variable-proposal`) trigger sibling dismissal via `chatPanel.dismissBatch` when acted on.

---

## New Policy Creation

Handled by `handleCreatePolicy()` in `renderer.ts`. Creates a policy, parses the markdown document into sections, and shows the progressive import accordion.

```mermaid
sequenceDiagram
    participant U as User
    participant NPM as NewPolicyModal
    participant R as renderer.ts
    participant PS as PolicyService
    participant State as policy-state.ts
    participant DP as DocumentPreviewPanel
    participant TP as TestPanel
    participant CP as ChatPanelComponent

    U->>R: Click "New Policy"
    R->>NPM: show()
    U->>NPM: Enter name, choose markdown file, set heading level
    U->>NPM: Click "Create Policy"
    NPM->>R: onCreatePolicy(name, filePath, maxLevel)
    R->>R: showScreen("building-screen")

    R->>PS: createPolicy(name)
    PS-->>R: policyArn

    R->>R: parseMarkdownSections(text, maxLevel)
    R->>State: Initialize local state with sections
    R->>State: persistLocalState()

    R->>R: showScreen("workspace-screen")
    Note over R: Waits for workspaceReadyPromise (WorkspaceLayout.onReady)
    R->>DP: loadSections(sections, sectionImports, maxLevel)
    R->>DP: wireSectionHandlers(docPreview, deps)
    R->>TP: loadTests([])
    R->>CP: appendMessage(welcome guidance)
```

---

## Open Existing Policy

Handled by `loadPolicy()` in `src/workflows/policy-loader.ts`. Receives `PolicyLoaderDeps` from `renderer.ts`.

```mermaid
sequenceDiagram
    participant U as User
    participant PP as PolicyPickerModal
    participant R as renderer.ts
    participant PL as policy-loader.ts
    participant PS as PolicyService
    participant CSM as ChatSessionManager
    participant BO as BuildOrchestrator
    participant DP as DocumentPreviewPanel
    participant TP as TestPanel
    participant CP as ChatPanelComponent

    U->>R: Click "Open Policy"
    R->>PP: showPolicyPicker()
    R->>PS: listPolicies()
    PS-->>R: policies[]
    R->>PP: showPolicies(policies)

    U->>PP: Select a policy
    PP->>R: onPolicySelected(policyArn, name)
    R->>R: showScreen("workspace-screen")
    Note over R: Waits for workspaceReadyPromise (WorkspaceLayout.onReady)
    R->>PL: loadPolicy(policyArn, name, deps)

    PL->>BO: clearAllPollingIntervals()
    PL->>CSM: clearTestSessions()
    PL->>CSM: configureMcpTools + connect(systemPrompt)
    PL->>PS: exportPolicyDefinition(policyArn)

    PL->>PL: loadMetadata via IPC
    PL->>PL: loadLocalState via IPC

    alt Progressive import (sections not all imported)
        PL->>PL: loadProgressiveImportMode()
        PL->>DP: loadSections(sections, sectionImports)
        PL->>PL: Restore cached fidelity reports
        PL->>PL: Recover in-progress section builds
    else Has documentPath
        PL->>DP: loadDocument(text)
    else No document
        PL->>DP: showOpenPrompt(...)
    end

    PL->>CSM: loadChatHistoryFromDisk(POLICY_CHAT_ID)
    PL->>BO: loadLatestBuildAssets(policyArn)
    PL->>BO: applyFidelityReport()
    PL->>PS: loadTestsWithResults(policyArn, buildId)
    PL->>TP: loadTests(results)
    PL->>BO: pollBackgroundWorkflows(policyArn)
    PL->>CSM: sendPolicyMessage(initial greeting)
    PL->>CP: startStreaming() → pushStreamChunk → endStreaming()
```

---

## Progressive Section Import

Handled by `importSection()` and `importMultipleSections()` in `src/workflows/section-import.ts`. Receives `SectionImportDeps` from `renderer.ts` via `buildSectionImportDeps()`. Fidelity reports are managed at the whole-policy level by `BuildOrchestrator`, not per-section.

```mermaid
sequenceDiagram
    participant U as User
    participant DP as DocumentPreviewPanel
    participant SIS as section-import.ts (workflow)
    participant Dialog as SectionImportModal
    participant PS as PolicyService
    participant CS as ChatService (policy)
    participant CP as ChatPanelComponent
    participant TP as TestPanel

    U->>DP: Click "Import" on a section
    DP->>SIS: importSection(section, deps)
    SIS->>Dialog: show(section.title)

    U->>Dialog: (optional) Click "Suggest Instructions"
    Dialog->>SIS: onSuggestInstructions(callback)
    SIS->>CS: sendPolicyMessage(summarization prompt)
    CS-->>SIS: instructions text
    SIS->>Dialog: callback(instructions)

    U->>Dialog: Click "Confirm"
    Dialog->>SIS: onConfirm(instructions)

    SIS->>PS: exportPolicyDefinition (or empty for first import)
    SIS->>PS: ensureBuildSlot(policyArn)
    SIS->>PS: startBuild(INGEST_CONTENT, section content)
    SIS->>PS: pollBuild(policyArn, buildId)

    SIS->>SIS: loadBuildAssets(policyArn, buildId)
    SIS->>PS: updatePolicy(policyArn, definition)

    SIS->>PS: getBuildAssets(GENERATED_TEST_CASES)
    loop Each generated test
        SIS->>PS: createTestCase(...)
    end

    SIS->>PS: runTests + pollTestCompletion

    SIS->>PS: loadTestsWithResults(policyArn, buildId)
    SIS->>TP: loadTests(results)
    SIS->>CP: updateKnownEntities(ruleIds, variableNames)

    SIS->>CS: sendPolicyMessage(greeting prompt)
    SIS->>CP: startStreaming() → pushStreamChunk → endStreaming()

    SIS->>SIS: pollBackgroundWorkflows(policyArn) [background]
```

---

## Build Workflow Monitoring

Handled by `BuildOrchestrator.pollBackgroundWorkflows()` in `src/services/build-orchestrator.ts`.

```mermaid
flowchart TD
    Start[pollBackgroundWorkflows called] --> List[policyService.listBuilds]
    List --> Filter{Any in-progress builds?}
    Filter -->|No| Done[Return]
    Filter -->|Yes| ForEach[For each in-progress build]

    ForEach --> IsFidelity{Is GENERATE_FIDELITY_REPORT?}

    IsFidelity -->|Yes| ShowDocLoader[ui.docSetLoading true]
    IsFidelity -->|No| ShowTestLoader[ui.testSetLoading true]

    ShowDocLoader --> Poll[setInterval every 5s]
    ShowTestLoader --> Poll

    Poll --> CheckStatus[policyService.getBuild]
    CheckStatus --> StillActive{Still active?}

    StillActive -->|Yes, non-fidelity| IncrementalTests[Incremental test refresh via ui.testLoadTests]
    IncrementalTests --> Wait[Wait for next tick]
    StillActive -->|Yes, fidelity| Wait

    StillActive -->|No - Completed| BuildDone{Build type?}

    BuildDone -->|Fidelity| LoadFidelity[getBuildAssets FIDELITY_REPORT]
    LoadFidelity --> ParseFidelity[parseFidelityAsset]
    ParseFidelity --> ApplyHighlights[ui.docSetHighlights]
    ApplyHighlights --> SaveMeta[saveFidelityReportToMetadata]
    SaveMeta --> ClearDocLoader[ui.docSetLoading false]

    BuildDone -->|Non-fidelity| FinalTestRefresh[loadTestsWithResults → ui.testLoadTests]
    FinalTestRefresh --> ClearTestLoader[ui.testSetLoading false]

    StillActive -->|No - Failed| ClearLoaders[Clear loading indicators]
```

---

## Fidelity Report Flow

Handled by `BuildOrchestrator.applyFidelityReport()` in `src/services/build-orchestrator.ts`.

```mermaid
flowchart TD
    Entry[applyFidelityReport called] --> HasReport{buildAssetsStore has fidelityReport?}

    HasReport -->|Yes| ApplyDirect[ui.docSetHighlights]
    ApplyDirect --> SaveMeta[saveFidelityReportToMetadata]

    HasReport -->|No| HasPolicy{state.getPolicy and state.getDefinition?}
    HasPolicy -->|No| Skip[Skip]

    HasPolicy -->|Yes| EnsureSlot[policyService.ensureBuildSlot]
    EnsureSlot --> StartBuild[policyService.startFidelityReportBuild]
    StartBuild --> PollLoop[Poll every 5s, max 60 attempts]

    PollLoop --> PollCheck{Build status?}
    PollCheck -->|Active| PollLoop
    PollCheck -->|Completed| FetchAsset[getBuildAssets FIDELITY_REPORT]
    FetchAsset --> Parse[parseFidelityAsset]
    Parse --> Apply[ui.docSetHighlights]

    PollCheck -->|Failed| ShowFail[Show failure message]
    PollCheck -->|Timeout| Timeout[Leave loader on for background poller]
```

---

## Test Panel Interactions

Test panel event handlers are wired by `wireTestPanelHandlers()` in `src/workflows/test-workflows.ts`. It receives `TestWorkflowDeps` from `renderer.ts`.

```mermaid
flowchart TD
    subgraph "Test Selection (wireTestPanelHandlers)"
        Select[User clicks test item] --> OnSelect[testPanel.onTestSelect]
        OnSelect --> Cancel[chatSessionMgr.cancelActivePrompt]
        Cancel --> SaveSession[Save current session to cache]
        SaveSession --> SetSelected[testPanel.setSelectedTest]
        SetSelected --> SetContext[chatPanel.setContext]
        SetContext --> ApplyFilter[applyTestHighlightFilter → docPreview]
        ApplyFilter --> CheckCache{Session in cache?}
        CheckCache -->|Yes| Restore[Restore cached session + messages]
        CheckCache -->|No disk| NewSession[chatSessionMgr.startTestChatSession]
        CheckCache -->|Disk cache| DiskRestore[Load from disk, create new ChatService]
    end

    subgraph "Test Deselection"
        Deselect[testPanel.onTestDeselect] --> CacheSession[Cache test session]
        CacheSession --> ClearTest[chatSessionMgr.testChatService = null]
        ClearTest --> ClearFilter[docPreview.clearFilter]
        ClearFilter --> RestorePolicy[Restore policy chat from disk]
    end

    subgraph "Back to Policy"
        Back[chatPanel.onBackToPolicy] --> DeselectTest[testPanel.deselectTest]
        DeselectTest --> OnDeselect[onTestDeselect: cancel, cache test, restore policy chat]
    end

    subgraph "Create Test"
        Create[testPanel.onCreateTest] --> API[policyService.createTestCase]
        API --> Refresh[loadTestsWithResults → testPanel.loadTests]
        Refresh --> AutoSelect[Auto-select new test]
    end

    subgraph "Suggest Test"
        Suggest[testPanel.onSuggestTest] --> TempService[Create temporary ChatService]
        TempService --> SendPrompt[Send suggestion prompt]
        SendPrompt --> Parse[Parse JSON response]
        Parse --> Populate[testPanel.populateForm]
    end

    subgraph "Refresh Tests"
        RefreshBtn[testPanel.onRefreshTests] --> FindBuild[policyService.findLatestPolicyBuild]
        FindBuild --> Reload[policyService.loadTestsWithResults]
        Reload --> Update[testPanel.loadTests]
    end
```

---

## Test Chat Session Lifecycle

Managed by `ChatSessionManager` in `src/services/chat-session-manager.ts`. Each test gets its own isolated ChatService session with a test-specific system prompt.

```mermaid
sequenceDiagram
    participant U as User
    participant TP as TestPanel
    participant TW as test-workflows.ts
    participant CSM as ChatSessionManager
    participant TCS as Test ChatService
    participant PCS as Policy ChatService
    participant CP as ChatPanelComponent

    Note over PCS: Policy session stays alive in background

    U->>TP: Click test item
    TP->>TW: onTestSelect(test)
    TW->>CSM: cancelActivePrompt()

    alt Previous test session exists
        TW->>CSM: Save to testSessionCache
    end

    TW->>TP: setSelectedTest(testId)
    TW->>CP: setContext("Test: ...")
    TW->>TW: applyTestHighlightFilter(test)

    alt Cached session for this test
        TW->>CSM: Restore from testSessionCache
        TW->>CP: restoreMessages(html)
    else Disk cache exists
        TW->>CSM: loadChatHistoryFromDisk(testId)
        TW->>TCS: new ChatService() + connect(testSystemPrompt)
        TW->>CP: restoreMessages(diskHtml)
    else New session
        TW->>CSM: startTestChatSession(test)
        CSM->>CP: clearMessages()
        CSM->>TCS: new ChatService() + connect(testSystemPrompt)
        CSM->>TCS: sendPolicyMessage(buildTestAnalysisPrompt)
        loop Streaming
            TCS-->>CSM: onUpdate chunks
            CSM->>CP: pushStreamChunk(text)
        end
        CSM->>CP: endStreaming()
    end

    Note over TW: User messages now route to TCS via activeChatService()

    U->>CP: Click "Back to Policy"
    CP->>TW: onBackToPolicy
    TW->>TP: deselectTest()
    TP->>TW: onTestDeselect
    TW->>CSM: cancelActivePrompt()
    TW->>CSM: Cache test session
    TW->>CSM: testChatService = null
    TW->>CP: Restore policy chat from cache
    Note over TW: activeChatService() now returns PCS
```

---

## Document Preview Interactions

```mermaid
flowchart TD
    subgraph "Highlight Sources"
        Summary[setHighlightsFromSummary] --> Render
        Fidelity[setHighlightsFromFidelityReport<br/>via BuildOrchestrator] --> Render
    end

    subgraph "Filtering"
        TestSelect[Test selected] --> ComputeFilter["computeTestHighlightFilter<br/>(test-workflows.ts)"]
        ComputeFilter --> FilterTest[docPreview.filterByTestFindings]
        EntityClick[Entity link in chat] --> FilterEntity[docPreview.filterByEntity]
        CardAction["Card show-source<br/>(card-actions.ts)"] --> Emphasize[docPreview.emphasize]
        ClearBtn[Back / deselect] --> ClearFilter[docPreview.clearFilter]
    end

    subgraph "User Interactions"
        HighlightClick[User clicks highlight] --> OnClick[onHighlightClick]
        OnClick --> CheckType{Rule or variable?}
        CheckType -->|Rule| SendRuleChat["chatPanel.onSendMessage<br/>'Explain rule X'"]
        CheckType -->|Variable| SendVarChat["chatPanel.onSendMessage<br/>'Explain the variable X<br/>and how it's used'"]
        RegenClick[User clicks Regenerate] --> OnRegen[onRegenerateFidelityReport]
        OnRegen --> ClearAssets[Clear fidelityReport from store]
        ClearAssets --> ApplyFidelity[buildOrchestrator.generateFidelityReport]
    end

    Render[Render highlights on document]
    FilterTest --> Render
    FilterEntity --> Render
    Emphasize --> Render
    ClearFilter --> Render
```

---

## Policy Update Detection

When the agent modifies the policy via REFINE_POLICY, the chat message handler detects it and delegates to `refreshTestsAfterPolicyChange()` in `test-workflows.ts`.

> **Note:** There are two overlapping event paths that trigger test refresh after
> tool execution. The `onAcpUpdate` path catches agent-initiated test runs that
> go through the MCP subprocess (which doesn't flow through the renderer's
> `PolicyService` instance). The `onTestsExecuted` path catches tests run through
> `PolicyService` directly. Consider consolidating into a single event path.

```mermaid
sequenceDiagram
    participant Agent as Kiro CLI Agent
    participant CS as ChatService
    participant AS as agent-stream.ts
    participant CMW as chat-message.ts
    participant TW as test-workflows.ts
    participant PS as PolicyService
    participant BO as BuildOrchestrator
    participant TP as TestPanel
    participant CP as ChatPanelComponent

    Note over AS: installStreamHandler watches for tool_call events

    Agent->>CS: tool_call: update-automated-reasoning-policy
    CS->>AS: onUpdate({ sessionUpdate: "tool_call", title: "...update..." })
    Note over AS: Title string match:<br/>title.includes('update-automated-reasoning-policy')
    AS->>CMW: policyWasUpdated = true

    Agent->>CS: prompt complete
    CS->>CMW: returns response

    CMW->>CMW: Check policyWasUpdated flag (in finally block)

    alt Policy was updated
        CMW->>TW: refreshTestsAfterPolicyChange(testWorkflowDeps)
        TW->>PS: listBuilds(policyArn)
        TW->>PS: findLatestPolicyBuild(builds)

        alt Build changed
            TW->>BO: loadBuildAssets(policyArn, newBuildId)
            alt No fidelity report on new build
                TW->>CP: appendMessage(stale fidelity prompt)
            end
        end

        TW->>PS: loadTestsWithResults(policyArn, buildId)
        TW->>TP: loadTests(results)

        alt Test currently selected
            TW->>TW: applyTestHighlightFilter(test)
        end
    end
```

### Additional Test Refresh Triggers (wired in `initializeWorkspaceUI`)

| Trigger | Event Type | Source |
|---------|-----------|--------|
| `policyService.onTestsExecuted()` | Callback | Tests run through renderer's `PolicyService` directly |
| `window.architect.onAcpUpdate` | `tool_call_update` (status: `completed`, title matches `/execute_tests/i`) | Agent-initiated test runs via MCP subprocess |

Both call `refreshTestsAfterPolicyChange()`.

---

## MCP Server Subprocess

The MCP server (`src/mcp-server-entry.ts`) runs as a separate process spawned by the Kiro CLI. It has no access to renderer state or UI callbacks — it owns its own `PolicyService` and `PolicyWorkflowService` instances with independent AWS credentials.

```
Kiro CLI ──stdio──► mcp-server-entry.ts
                      ├── PolicyService (own SDK client)
                      ├── PolicyWorkflowService
                      ├── ContextIndex (loaded from CONTEXT_INDEX_FILE, cached with fs.watch)
                      ├── mcp-request-handler.ts (JSON-RPC routing)
                      └── policy-mcp-server.ts (tool definitions + dispatch)
```

The MCP server and the renderer share two filesystem-based IPC artifacts:

1. **Approval code file** (`APPROVAL_CODE_FILE`): Renderer writes approval codes via `approval:writeCode` IPC → `approval-code-store.writeApprovalCode()`. MCP server consumes codes via `approval-code-store.consumeApprovalCode()` before executing policy-mutating tools.

2. **Context index file** (`CONTEXT_INDEX_FILE`): Renderer serializes the `ContextIndex` to a temp file whenever the index is rebuilt (after policy load, definition changes, fidelity report generation). MCP server loads the file at startup and watches for changes via `fs.watch`, keeping an in-memory cache fresh without polling. The search tools (`search_document`, `search_rules`, etc.) query this cached index.

This means agent tool calls that mutate the policy happen in a different process than the one displaying the UI. The renderer only learns about mutations through the `acp:session-update` / `tool_call_update` event stream forwarded from the Kiro CLI.

---

## Callback Wiring Summary

Components emit events via callbacks. The composition root (`renderer.ts`) wires them to workflows and services. Workflows are wired via `wireTestPanelHandlers()`, `createCardActionHandler()`, and `createSendMessageHandler()`.

| Component | Callback | Wired To | Module |
|-----------|----------|----------|--------|
| `ChatPanelComponent.onSendMessage` | `createSendMessageHandler(deps)` | `chat-message.ts` |
| `ChatPanelComponent.onCardAction` | `createCardActionHandler(deps)` | `card-actions.ts` |
| `ChatPanelComponent.onBackToPolicy` | Delegates to `testPanel.deselectTest()` | `test-workflows.ts` |
| `ChatPanelComponent.onEntityClick` | `docPreview.filterByEntity()` | `renderer.ts` |
| `TestPanel.onTestSelect` | Start/restore test chat session | `test-workflows.ts` |
| `TestPanel.onTestDeselect` | Cache session, clear filter, restore policy | `test-workflows.ts` |
| `TestPanel.onRefreshTests` | `policyService.loadTestsWithResults()` | `test-workflows.ts` |
| `TestPanel.onCreateTest` | `policyService.createTestCase()` + refresh | `test-workflows.ts` |
| `TestPanel.onSuggestTest` | Temporary ChatService for suggestion | `test-workflows.ts` |
| `DocumentPreviewPanel.onHighlightClick` | `chatPanel.onSendMessage("Explain rule/variable X")` | `renderer.ts` |
| `DocumentPreviewPanel.onImportSection` | `importSection(section, deps)` | `section-import.ts` (workflow) |
| `DocumentPreviewPanel.onImportMultipleSections` | `importMultipleSections(sections, deps)` | `section-import.ts` (workflow) |
| `DocumentPreviewPanel.onRegenerateFidelityReport` | `buildOrchestrator.generateFidelityReport()` | `renderer.ts` |
| `DocumentPreviewPanel.onEntityFilterBack` | No-op (filter already cleared) | `renderer.ts` |
| `DocumentPreviewPanel.onGranularityChange` | Re-parse sections, update accordion | `section-wiring.ts` / `renderer.ts` |
| `PolicyPickerModal.onSelect` | `loadPolicy(policyArn, name)` | `policy-loader.ts` |
| `PolicyPickerModal.onDismiss` | `setPickerVisible(false)` | `App.tsx` |
| `NewPolicyModal.onCreate` | Full new policy creation workflow | `renderer.ts` |
| `NewPolicyModal.onDismiss` | `setNewPolicyVisible(false)` | `App.tsx` |
| `policyService.onTestsExecuted` | `refreshTestsAfterPolicyChange()` | `renderer.ts` |
| `window.architect.onAcpUpdate` (global) | Detect `execute_tests` completion → refresh tests | `renderer.ts` |

---

## Debug Logging & Export

The debug logging system captures structured events in the main process and provides a user-facing export via the Help menu. The `DebugLogger` is the only new event consumer — it taps existing ACP event streams without adding new producers.

### Event Consumers

| Event | Existing consumers (unchanged) | New consumer |
|-------|-------------------------------|-------------|
| `session-update` | IPC forward → `logToolFailure` → conditional `logAgentTrace` | `debugLogger.logEvent` (tail position) |
| `stderr` | `console.error` → IPC forward | `debugLogger.logEvent` (tail position) |
| `exit` | `console.log` → IPC forward | `debugLogger.logEvent` (tail position) |

### Debug Export Flow

```mermaid
sequenceDiagram
    participant U as User
    participant Menu as Help Menu
    participant M as Main Process
    participant R as Renderer (App.tsx)
    participant DL as DebugLogger
    participant PS as policy-state.ts

    U->>Menu: Click "Download Debug Info" (⇧⌘D)
    Menu->>M: menu click handler
    M->>R: debug:requestExport (IPC)
    R->>PS: buildDebugSnapshot() (sync read from getters)
    R->>M: debug:export (IPC, stateSnapshot JSON)
    M->>DL: readRecentEntries(1000)
    DL-->>M: DebugLogEntry[]
    M->>M: Combine snapshot + logs + app metadata
    M->>U: Save dialog
    U->>M: Choose file path
    M->>M: Write JSON file
    M-->>R: file path (IPC response)
    R->>R: Show Flashbar success notification (auto-dismiss 5s)
```

### Log Storage

- Location: `~/.ARchitect/logs/debug.jsonl`
- Format: JSON-lines (one `DebugLogEntry` per line)
- Rotation: 10 MB max per file, 2 rotated files kept (`.1`, `.2`)
- Always active — no env var required (unlike `ARCHITECT_DEBUG` terminal logging)

### Selective IPC Logging

The following IPC handlers log request metadata to the debug log:

| Channel | Logged fields |
|---------|--------------|
| `acp:start` | `cwd` |
| `acp:createSession` | `cwd` |
| `acp:sendPrompt` | `sessionId`, `promptLength` |
