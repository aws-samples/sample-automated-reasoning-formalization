/**
 * BuildingScreen — Cloudscape replacement for the building/loading screen.
 *
 * Shows a spinner with status text during policy creation, or an error
 * alert with a back button if something goes wrong.
 */
import Header from "@cloudscape-design/components/header";
import Button from "@cloudscape-design/components/button";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Spinner from "@cloudscape-design/components/spinner";
import Alert from "@cloudscape-design/components/alert";

interface BuildingScreenProps {
  title: string;
  statusText: string;
  error: string | null;
  onBack: () => void;
}

export function BuildingScreen({ title, statusText, error, onBack }: BuildingScreenProps) {
  return (
    <>
      <div className="titlebar" />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1 }}>
      <Container>
        <SpaceBetween size="l" alignItems="center">
          {!error && <Spinner size="large" />}
          <Header variant="h2">{title}</Header>
          {error ? (
            <SpaceBetween size="m" alignItems="center">
              <Alert type="error">{error}</Alert>
              <Button variant="normal" onClick={onBack}>Back</Button>
            </SpaceBetween>
          ) : (
            <Box color="text-body-secondary" fontSize="body-m">
              {statusText}
            </Box>
          )}
        </SpaceBetween>
      </Container>
      </div>
    </>
  );
}
