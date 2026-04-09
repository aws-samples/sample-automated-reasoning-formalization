/**
 * TestCard — status report for a test execution result.
 * Shows question, expected answer, actual result, and findings.
 */
import { useState } from "react";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Button from "@cloudscape-design/components/button";
import Box from "@cloudscape-design/components/box";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import { ActionCardContainer } from "./ActionCardContainer";

interface TestCardProps {
  testId?: string;
  answer?: string;
  question?: string;
  expectedStatus?: string;
  actualStatus?: string;
  findingsSummary?: string;
  onAction: (action: string, data: unknown) => void;
}

function humanizeStatus(s: string | undefined): string {
  if (!s) return "Unknown";
  const map: Record<string, string> = {
    VALID: "Yes, confirmed by policy",
    SATISFIABLE: "Possibly, but not guaranteed",
    UNSATISFIABLE: "No, contradicted by policy",
    COMPLIANT: "Yes",
    NON_COMPLIANT: "No",
  };
  return map[s] ?? s;
}

export function TestCard({ testId, answer, question, expectedStatus, actualStatus, findingsSummary, onAction }: TestCardProps) {
  const [rerunning, setRerunning] = useState(false);
  const [investigating, setInvestigating] = useState(false);
  const passed = expectedStatus === actualStatus;

  return (
    <ActionCardContainer
      header={passed ? "Test passed" : "Test found a mismatch"}
      actions={
        <>
          <Button
            variant="normal"
            disabled={rerunning}
            onClick={() => {
              setRerunning(true);
              onAction("rerun-test", { testId, answer, question });
            }}
          >
            {rerunning ? "Running…" : "Re-run test"}
          </Button>
          <Button
            variant="normal"
            disabled={investigating}
            onClick={() => {
              setInvestigating(true);
              onAction("dive-deeper", { testId, answer, question, expectedStatus, actualStatus, findingsSummary });
            }}
          >
            {investigating ? "Investigating…" : "Investigate this"}
          </Button>
        </>
      }
    >
      <SpaceBetween size="xs">
        <StatusIndicator type={passed ? "success" : "error"}>
          {passed ? "Policy answered as expected" : "Policy's answer didn't match expectations"}
        </StatusIndicator>
        <div>
          <Box color="text-body-secondary" fontSize="body-s">Question</Box>
          <Box>{question ?? ""}</Box>
        </div>
        <div>
          <Box color="text-body-secondary" fontSize="body-s">Expected answer</Box>
          <Box>{answer ?? ""}</Box>
        </div>
        <Box fontSize="body-s">
          Expected: <strong>{humanizeStatus(expectedStatus)}</strong> · Actual: <strong>{humanizeStatus(actualStatus)}</strong>
        </Box>
        {findingsSummary && <Box>{findingsSummary}</Box>}
      </SpaceBetween>
    </ActionCardContainer>
  );
}
