/**
 * LandingScreen — Cloudscape replacement for the static HTML landing screen.
 *
 * Centered layout with app title, subtitle, and two action buttons:
 * "Import Document" (primary) and "Open Existing Policy" (normal).
 */
import Header from "@cloudscape-design/components/header";
import Button from "@cloudscape-design/components/button";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";

interface LandingScreenProps {
  onNewPolicy: () => void;
  onOpenPolicy: () => void;
}

export function LandingScreen({ onNewPolicy, onOpenPolicy }: LandingScreenProps) {
  return (
    <>
      <div className="titlebar" />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1 }}>
        <Container>
        <SpaceBetween size="l" alignItems="center">
          <SpaceBetween size="xxs" alignItems="center">
            <Header variant="h1">ARchitect</Header>
            <Box color="text-body-secondary" fontSize="body-m">
              Automated Reasoning policy editor
            </Box>
          </SpaceBetween>
          <SpaceBetween direction="horizontal" size="s">
            <Button variant="primary" onClick={onNewPolicy}>
              Import Document
            </Button>
            <Button variant="normal" onClick={onOpenPolicy}>
              Open Existing Policy
            </Button>
          </SpaceBetween>
        </SpaceBetween>
      </Container>
      </div>
    </>
  );
}
