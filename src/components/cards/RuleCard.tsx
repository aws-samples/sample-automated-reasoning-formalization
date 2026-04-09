/**
 * RuleCard — artifact preview for an AI-generated policy rule.
 * Shows natural language interpretation with source navigation.
 */
import { useState } from "react";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Button from "@cloudscape-design/components/button";
import Box from "@cloudscape-design/components/box";
import Link from "@cloudscape-design/components/link";

interface RuleCardProps {
  ruleId?: string;
  naturalLanguage?: string;
  onAction: (action: string, data: unknown) => void;
}

export function RuleCard({ ruleId, naturalLanguage, onAction }: RuleCardProps) {
  const [confirmed, setConfirmed] = useState(false);

  return (
    <Container
      header={
        <Header variant="h3">
          Rule{" "}
          {ruleId && (
            <Link
              onFollow={(e) => {
                e.preventDefault();
                onAction("filter-entity", { entityType: "rule", entityId: ruleId });
              }}
            >
              {ruleId}
            </Link>
          )}
        </Header>
      }
    >
      <SpaceBetween size="s">
        <Box>{naturalLanguage ?? ""}</Box>

        <SpaceBetween direction="horizontal" size="xs">
          <Button
            variant="normal"
            onClick={() => onAction("show-source", { ruleId })}
          >
            Show source
          </Button>
          <Button
            variant="primary"
            disabled={confirmed}
            onClick={() => {
              setConfirmed(true);
              onAction("update-rule", {
                ruleId,
                prompt: `I'd like to change the rule that says: "${naturalLanguage}" — specifically, `,
              });
            }}
          >
            {confirmed ? "Updating…" : "Fix this rule"}
          </Button>
        </SpaceBetween>
      </SpaceBetween>
    </Container>
  );
}
