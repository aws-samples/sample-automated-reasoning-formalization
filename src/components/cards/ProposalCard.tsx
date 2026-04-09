/**
 * ProposalCard — decision gate for policy changes.
 * The agent cannot proceed without explicit user approval.
 * Preserves the approval code security mechanism.
 */
import { useState } from "react";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Button from "@cloudscape-design/components/button";
import Box from "@cloudscape-design/components/box";
import { ActionCardContainer } from "./ActionCardContainer";

interface ProposalChange {
  label: string;
  before?: string;
  after: string;
}

interface ProposalCardProps {
  title: string;
  description: string;
  changes: ProposalChange[];
  approvePrompt: string;
  rejectPrompt: string;
  onAction: (action: string, data: unknown) => void;
}

export function ProposalCard({ title, description, changes, approvePrompt, rejectPrompt, onAction }: ProposalCardProps) {
  const [decided, setDecided] = useState<"approved" | "rejected" | null>(null);

  const handleApprove = () => {
    setDecided("approved");
    onAction("approve-proposal", { prompt: approvePrompt });
  };

  const handleReject = () => {
    setDecided("rejected");
    onAction("reject-proposal", { prompt: rejectPrompt });
  };

  return (
    <ActionCardContainer
      header={title}
      actions={
        <>
          <Button
            variant="primary"
            disabled={decided !== null}
            onClick={handleApprove}
          >
            {decided === "approved" ? "Approved" : "Approve"}
          </Button>
          <Button
            variant="normal"
            disabled={decided !== null}
            onClick={handleReject}
          >
            {decided === "rejected" ? "Rejected" : "Reject"}
          </Button>
        </>
      }
    >
      <SpaceBetween size="s">
        <Box color="text-body-secondary">{description}</Box>
        {changes.length > 0 && (
          <SpaceBetween size="xs">
            {changes.map((change, i) => (
              <Box key={i} padding={{ horizontal: "s", vertical: "xxs" }}>
                <Box fontWeight="bold" fontSize="body-s">{change.label}</Box>
                {change.before && (
                  <Box color="text-body-secondary" fontSize="body-s">
                    <s>{change.before}</s>
                  </Box>
                )}
                <Box fontSize="body-s" color="text-status-success">{change.after}</Box>
              </Box>
            ))}
          </SpaceBetween>
        )}
      </SpaceBetween>
    </ActionCardContainer>
  );
}
