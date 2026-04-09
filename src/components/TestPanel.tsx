/**
 * TestPanel — React component for the test case list.
 *
 * Displays test cases with pass/fail status, a create form,
 * and keyboard navigation. Replaces the imperative test-panel.ts class.
 */
import { useState, useCallback, useRef, useEffect } from "react";
import type { TestCaseWithResult } from "../types";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Button from "@cloudscape-design/components/button";
import Box from "@cloudscape-design/components/box";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Spinner from "@cloudscape-design/components/spinner";
import FormField from "@cloudscape-design/components/form-field";
import Textarea from "@cloudscape-design/components/textarea";

export interface TestPanelHandle {
  loadTests: (tests: TestCaseWithResult[]) => void;
  setSelectedTest: (testId: string | null) => void;
  getSelectedTestId: () => string | null;
  updateTestResult: (testId: string, result: Partial<TestCaseWithResult>) => void;
  setLoading: (loading: boolean, message?: string) => void;
  showCreateForm: () => void;
  hideCreateForm: () => void;
  populateForm: (question: string, answer: string) => void;
  setSuggestLoading: (loading: boolean) => void;
  setGenerateFromSelectionLoading: (loading: boolean) => void;
  deselectTest: () => void;
  showEmptyImportState: () => void;
  // Callback setters (for workflow wiring)
  onTestSelect?: (test: TestCaseWithResult) => void;
  onTestDeselect?: () => void;
  onRefreshTests?: () => void;
  onCreateTest?: (question: string, answer: string) => void;
  onSuggestTest?: () => void;
}

type StatusInfo = { type: "success" | "error" | "pending" | "in-progress"; label: string };

function getTestStatus(test: TestCaseWithResult): StatusInfo {
  if (!test.testRunStatus || test.testRunStatus === "NOT_STARTED") {
    return { type: "pending", label: "Not yet run" };
  }
  if (test.testRunStatus === "IN_PROGRESS" || test.testRunStatus === "SCHEDULED") {
    return { type: "in-progress", label: "Running" };
  }
  if (test.testRunStatus === "FAILED") {
    return { type: "error", label: "Execution failed" };
  }
  const expected = test.testCase.expectedAggregatedFindingsResult;
  const actual = test.aggregatedTestFindingsResult;
  if (actual && expected && actual === expected) {
    return { type: "success", label: "Passed" };
  }
  if (actual && expected && actual !== expected) {
    return { type: "error", label: "Failed" };
  }
  return { type: "pending", label: "No result" };
}

function humanizeResult(v: string): string {
  return v === "COMPLIANT" ? "Yes" : v === "NON_COMPLIANT" ? "No" : v;
}

interface TestPanelProps {
  /** Ref callback to expose the imperative handle for workflow wiring. */
  onHandle: (handle: TestPanelHandle) => void;
}

export function TestPanel({ onHandle }: TestPanelProps) {
  const [tests, setTests] = useState<TestCaseWithResult[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoadingState] = useState<{ active: boolean; message: string }>({ active: false, message: "" });
  const [formVisible, setFormVisible] = useState(false);
  const [formQuestion, setFormQuestion] = useState("");
  const [formAnswer, setFormAnswer] = useState("");
  const [suggestLoading, setSuggestLoadingState] = useState(false);
  const [emptyImport, setEmptyImport] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Stable refs for callbacks (set by workflows via the handle)
  const callbacksRef = useRef<{
    onTestSelect?: (test: TestCaseWithResult) => void;
    onTestDeselect?: () => void;
    onRefreshTests?: () => void;
    onCreateTest?: (question: string, answer: string) => void;
    onSuggestTest?: () => void;
  }>({});

  // Expose imperative handle
  useEffect(() => {
    const handle: TestPanelHandle = {
      loadTests: (newTests) => {
        setTests(newTests);
        setEmptyImport(false);
        // Preserve selection if test still exists
        setSelectedId((prev) => {
          if (prev && newTests.some((t) => t.testCase.testCaseId === prev)) return prev;
          return null;
        });
      },
      setSelectedTest: (id) => setSelectedId(id),
      getSelectedTestId: () => selectedId,
      updateTestResult: (testId, result) => {
        setTests((prev) => prev.map((t) =>
          t.testCase.testCaseId === testId ? { ...t, ...result } : t
        ));
      },
      setLoading: (active, message = "Loading tests…") => setLoadingState({ active, message }),
      showCreateForm: () => setFormVisible(true),
      hideCreateForm: () => { setFormVisible(false); setFormQuestion(""); setFormAnswer(""); },
      populateForm: (q, a) => { setFormQuestion(q); setFormAnswer(a); },
      setSuggestLoading: (l) => setSuggestLoadingState(l),
      setGenerateFromSelectionLoading: (l) => {
        if (l) { setFormVisible(true); setSuggestLoadingState(true); }
        else { setSuggestLoadingState(false); }
      },
      deselectTest: () => {
        setSelectedId(null);
        callbacksRef.current.onTestDeselect?.();
      },
      showEmptyImportState: () => { setTests([]); setEmptyImport(true); },
      // Callback setters — workflows assign these
      get onTestSelect() { return callbacksRef.current.onTestSelect; },
      set onTestSelect(fn) { callbacksRef.current.onTestSelect = fn; },
      get onTestDeselect() { return callbacksRef.current.onTestDeselect; },
      set onTestDeselect(fn) { callbacksRef.current.onTestDeselect = fn; },
      get onRefreshTests() { return callbacksRef.current.onRefreshTests; },
      set onRefreshTests(fn) { callbacksRef.current.onRefreshTests = fn; },
      get onCreateTest() { return callbacksRef.current.onCreateTest; },
      set onCreateTest(fn) { callbacksRef.current.onCreateTest = fn; },
      get onSuggestTest() { return callbacksRef.current.onSuggestTest; },
      set onSuggestTest(fn) { callbacksRef.current.onSuggestTest = fn; },
    };
    onHandle(handle);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const items = listRef.current?.querySelectorAll<HTMLElement>("[role='option']");
    if (!items || items.length === 0) return;
    const focused = document.activeElement as HTMLElement;
    const arr = Array.from(items);
    const idx = arr.indexOf(focused);

    if (e.key === "ArrowDown") {
      e.preventDefault();
      arr[(idx + 1) % arr.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      arr[(idx - 1 + arr.length) % arr.length]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setSelectedId(null);
      callbacksRef.current.onTestDeselect?.();
      arr[0]?.focus();
    }
  }, []);

  // Loading overlay
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", position: "relative" }}>
      {/* Loading overlay */}
      {loading.active && (
        <div style={{ position: "absolute", inset: 0, zIndex: 10, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--surface, #fff)" }}>
          <SpaceBetween size="s" alignItems="center">
            <Spinner />
            <Box color="text-body-secondary">{loading.message}</Box>
          </SpaceBetween>
        </div>
      )}

      {/* Toolbar */}
      <div className="test-toolbar">
        <Button variant="normal" fullWidth onClick={() => setFormVisible(true)}>
          + New Test
        </Button>
      </div>

      {/* Create form */}
      {formVisible && (
        <div style={{ padding: "0.75rem", borderBottom: "1px solid var(--border)" }}>
          <SpaceBetween size="s">
            <FormField label="Question">
              <Textarea
                value={formQuestion}
                onChange={({ detail }) => setFormQuestion(detail.value)}
                placeholder="Ask a question someone might ask about this policy…"
                rows={2}
                disabled={suggestLoading}
                autoFocus
              />
            </FormField>
            <FormField label="Expected answer">
              <Textarea
                value={formAnswer}
                onChange={({ detail }) => setFormAnswer(detail.value)}
                placeholder="What should the correct answer be?"
                rows={2}
                disabled={suggestLoading}
              />
            </FormField>
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                onClick={() => callbacksRef.current.onSuggestTest?.()}
                loading={suggestLoading}
                loadingText="Suggesting…"
              >
                Suggest
              </Button>
              <Button
                variant="primary"
                disabled={!formQuestion.trim() || !formAnswer.trim()}
                onClick={() => callbacksRef.current.onCreateTest?.(formQuestion.trim(), formAnswer.trim())}
              >
                Create Test
              </Button>
              <Button variant="icon" iconName="close" ariaLabel="Cancel"
                onClick={() => { setFormVisible(false); setFormQuestion(""); setFormAnswer(""); }}
              />
            </SpaceBetween>
          </SpaceBetween>
        </div>
      )}

      {/* Empty states */}
      {tests.length === 0 && !formVisible && (
        <Box textAlign="center" padding="l" color="text-body-secondary">
          {emptyImport
            ? <>No tests yet.<br /><br />Select a section from your document on the left and import it. Tests will be suggested automatically.</>
            : <>No tests yet.<br /><br />Tests check that your policy answers questions correctly. For example: <em>"Does a part-time employee get dental coverage?"</em><br /><br />Click '+ New Test' above to get started.</>
          }
        </Box>
      )}

      {/* Test list */}
      {tests.length > 0 && (
        <div ref={listRef} role="listbox" aria-label="Test cases" onKeyDown={handleKeyDown}
          style={{ flex: 1, overflowY: "auto" }}>
          {tests.map((test) => {
            const testId = test.testCase.testCaseId!;
            const status = getTestStatus(test);
            const isSelected = testId === selectedId;
            const query = test.testCase.queryContent ?? "";
            const guard = test.testCase.guardContent ?? "";
            const expected = test.testCase.expectedAggregatedFindingsResult;
            const actual = test.aggregatedTestFindingsResult;

            return (
              <div
                key={testId}
                role="option"
                aria-selected={isSelected}
                tabIndex={0}
                className={`test-item${isSelected ? " selected" : ""}`}
                onClick={() => callbacksRef.current.onTestSelect?.(test)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    callbacksRef.current.onTestSelect?.(test);
                  }
                }}
              >
                <span className="test-status-icon">
                  <StatusIndicator type={status.type}>{""}</StatusIndicator>
                </span>
                <div className="test-item-content">
                  {query && <span className="test-item-label test-item-query" title={query}>{query}</span>}
                  <span className="test-item-label test-item-guard" title={guard}>{guard}</span>
                  {actual && expected && actual !== expected && (
                    <span className="test-result-badge">
                      Expected: {humanizeResult(expected)} · Got: {humanizeResult(actual)}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
