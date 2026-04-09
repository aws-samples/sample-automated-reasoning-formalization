/**
 * VariableProposalCard — editable form for accepting or modifying
 * a proposed variable name.
 */
import { useState } from "react";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Button from "@cloudscape-design/components/button";
import Box from "@cloudscape-design/components/box";
import FormField from "@cloudscape-design/components/form-field";
import Input from "@cloudscape-design/components/input";
import Link from "@cloudscape-design/components/link";
import { ActionCardContainer } from "./ActionCardContainer";

interface VariableProposalCardProps {
  suggestedName: string;
  suggestedType: string;
  suggestedLabel: string;
  onAction: (action: string, data: unknown) => void;
}

export function VariableProposalCard({ suggestedName, suggestedType, suggestedLabel, onAction }: VariableProposalCardProps) {
  const [name, setName] = useState(suggestedName);
  const [decided, setDecided] = useState<"accepted" | "editing" | null>(null);

  return (
    <ActionCardContainer
      header={<>New Variable{" "}
        <Link onFollow={(e) => { e.preventDefault(); onAction("filter-entity", { entityType: "variable", entityId: suggestedName }); }}>
          {suggestedName}
        </Link>
      </>}
      actions={
        <>
          <Button variant="primary" disabled={decided !== null}
            onClick={() => { setDecided("accepted"); onAction("accept-variable", { name, type: suggestedType }); }}>
            {decided === "accepted" ? "Accepted" : "Looks good"}
          </Button>
          <Button variant="normal" disabled={decided !== null}
            onClick={() => { setDecided("editing"); onAction("change-variable", {}); }}>
            {decided === "editing" ? "Editing…" : "Edit name"}
          </Button>
        </>
      }
    >
      <SpaceBetween size="s">
        <FormField label="Variable name">
          <Input value={name} onChange={({ detail }) => setName(detail.value)} disabled={decided !== null} />
        </FormField>
        <Box color="text-body-secondary" fontSize="body-s">
          Type: {suggestedType} · {suggestedLabel}
        </Box>
      </SpaceBetween>
    </ActionCardContainer>
  );
}
