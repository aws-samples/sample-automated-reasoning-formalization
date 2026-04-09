/**
 * GuardrailValidationCard — artifact preview for a compliance check result.
 * Shows compliant/not compliant status with expandable findings.
 */
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Box from "@cloudscape-design/components/box";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import Link from "@cloudscape-design/components/link";

interface Finding {
  ruleId: string;
  description: string;
}

interface GuardrailValidationCardProps {
  compliant: boolean;
  llmResponse: string;
  findings?: Finding[];
  onAction: (action: string, data: unknown) => void;
}

export function GuardrailValidationCard({ compliant, llmResponse, findings, onAction }: GuardrailValidationCardProps) {
  return (
    <Container header={<Header variant="h3">Guardrail Validation</Header>}>
      <SpaceBetween size="s">
        <StatusIndicator type={compliant ? "success" : "error"}>
          {compliant ? "Compliant" : "Not Compliant"}
        </StatusIndicator>

        <Box>{llmResponse}</Box>

        {findings && findings.length > 0 && (
          <ExpandableSection headerText={`Findings (${findings.length})`}>
            <SpaceBetween size="xs">
              {findings.map((f, i) => (
                <Box key={i} fontSize="body-s">
                  <Link onFollow={(e) => { e.preventDefault(); onAction("highlight-rule", { ruleId: f.ruleId }); }}>
                    {f.ruleId}
                  </Link>
                  : {f.description}
                </Box>
              ))}
            </SpaceBetween>
          </ExpandableSection>
        )}
      </SpaceBetween>
    </Container>
  );
}
