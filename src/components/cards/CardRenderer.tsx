/**
 * CardRenderer — switches on card type and renders the appropriate
 * React card component. Used as the bridge between the imperative
 * streaming processor and React card components.
 */
import type { ChatCard } from "../../types";
import { RuleCard } from "./RuleCard";
import { TestCard } from "./TestCard";
import { ProposalCard } from "./ProposalCard";
import { PromptActionCard } from "./PromptActionCard";
import { VariableProposalCard } from "./VariableProposalCard";
import { GuardrailValidationCard } from "./GuardrailValidationCard";
import Box from "@cloudscape-design/components/box";

type CardActionHandler = (action: string, data: unknown) => void;

interface CardRendererProps {
  card: ChatCard;
  onAction: CardActionHandler;
}

export function CardRenderer({ card, onAction }: CardRendererProps) {
  switch (card.type) {
    case "rule":
      return <RuleCard ruleId={card.ruleId} naturalLanguage={card.naturalLanguage} onAction={onAction} />;
    case "test":
      return <TestCard testId={card.testId} answer={card.answer} question={card.question} expectedStatus={card.expectedStatus} actualStatus={card.actualStatus} findingsSummary={card.findingsSummary} onAction={onAction} />;
    case "proposal":
      return <ProposalCard title={card.title} description={card.description} changes={card.changes} approvePrompt={card.approvePrompt} rejectPrompt={card.rejectPrompt} onAction={onAction} />;
    case "next-steps":
      return <PromptActionCard label={card.summary} description={card.description} prompt={card.prompt} variant="next-step" onAction={onAction} />;
    case "follow-up-prompt":
      return <PromptActionCard label={card.label} prompt={card.prompt} variant="suggestion" onAction={onAction} />;
    case "variable-proposal":
      return <VariableProposalCard suggestedName={card.suggestedName} suggestedType={card.suggestedType} suggestedLabel={card.suggestedLabel} onAction={onAction} />;
    case "guardrail-validation":
      return <GuardrailValidationCard compliant={card.compliant} llmResponse={card.llmResponse} findings={card.findings} onAction={onAction} />;
    default:
      return <Box color="text-body-secondary">[Unknown card type]</Box>;
  }
}
