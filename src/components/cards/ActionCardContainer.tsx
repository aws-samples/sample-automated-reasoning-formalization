/**
 * ActionCardContainer — shared wrapper for action cards (decision points
 * and action triggers). Uses Cloudscape Container + SpaceBetween.
 */
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";

interface ActionCardContainerProps {
  header?: React.ReactNode;
  children: React.ReactNode;
  actions?: React.ReactNode;
}

export function ActionCardContainer({ header, children, actions }: ActionCardContainerProps) {
  return (
    <Container header={header ? <Header variant="h3">{header}</Header> : undefined}>
      <SpaceBetween size="s">
        {children}
        {actions && (
          <SpaceBetween direction="horizontal" size="xs">
            {actions}
          </SpaceBetween>
        )}
      </SpaceBetween>
    </Container>
  );
}
