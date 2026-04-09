/**
 * PromptActionCard — unified component for single-action prompt cards.
 * Replaces both FollowUpPromptCard and NextStepsCard.
 *
 * Variants:
 *  - "next-step" (default): singular recommended action from the agent
 *  - "suggestion": one of several options the user can pick from
 */
import { useState } from "react";
import Button from "@cloudscape-design/components/button";
import Box from "@cloudscape-design/components/box";
import { ActionCardContainer } from "./ActionCardContainer";

interface PromptActionCardProps {
  label: string;
  description?: string;
  prompt: string;
  variant?: "next-step" | "suggestion";
  onAction: (action: string, data: unknown) => void;
}

/** Max label length before falling back to a generic button label. */
const MAX_BUTTON_LABEL_LENGTH = 30;

export function PromptActionCard({ label, description, prompt, variant = "next-step", onAction }: PromptActionCardProps) {
  const [sent, setSent] = useState(false);
  const fallback = variant === "next-step" ? "Let's do this" : "Apply this suggestion";
  const btnLabel = label.length <= MAX_BUTTON_LABEL_LENGTH ? label : fallback;
  const ariaPrefix = variant === "next-step" ? "Execute next step" : "Apply suggestion";

  function handleClick() {
    setSent(true);
    onAction("execute-prompt", { prompt });
  }

  return (
    <ActionCardContainer
      header={label}
      actions={
        <Button
          variant="primary"
          disabled={sent}
          onClick={handleClick}
          ariaLabel={`${ariaPrefix}: ${label}`}
        >
          {sent ? "Sent" : btnLabel}
        </Button>
      }
    >
      <Box color="text-body-secondary" fontSize={description ? "body-m" : "body-s"}>
        {description ?? prompt}
      </Box>
    </ActionCardContainer>
  );
}
