/**
 * SectionImportModal — Cloudscape replacement for the imperative SectionImportDialog.
 *
 * Collects optional instructions before importing a document section.
 * Also implements SectionImportDialogHandle for backward compatibility
 * with the section-import workflow.
 */
import { useState, useEffect, useRef } from "react";
import Modal from "@cloudscape-design/components/modal";
import FormField from "@cloudscape-design/components/form-field";
import Textarea from "@cloudscape-design/components/textarea";
import Button from "@cloudscape-design/components/button";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Box from "@cloudscape-design/components/box";
import Alert from "@cloudscape-design/components/alert";

interface SectionImportModalProps {
  visible: boolean;
  sectionTitle: string;
  onDismiss: () => void;
  onConfirm: (instructions: string) => void;
  onSuggestInstructions: () => Promise<string>;
}

export function SectionImportModal({
  visible,
  sectionTitle,
  onDismiss,
  onConfirm,
  onSuggestInstructions,
}: SectionImportModalProps) {
  const [instructions, setInstructions] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  // Reset state when modal opens
  useEffect(() => {
    if (visible) {
      setInstructions("");
      setSuggesting(false);
      setSuggestError(false);
      mountedRef.current = true;
    }
  }, [visible]);

  const handleSuggest = async () => {
    setSuggesting(true);
    setSuggestError(false);
    try {
      const result = await onSuggestInstructions();
      if (mountedRef.current) setInstructions(result);
    } catch {
      if (mountedRef.current) setSuggestError(true);
    } finally {
      if (mountedRef.current) setSuggesting(false);
    }
  };

  const handleImport = () => {
    onConfirm(instructions.trim());
  };

  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      header={`Import: ${sectionTitle}`}
      size="medium"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="normal" onClick={onDismiss}>Cancel</Button>
            <Button variant="primary" onClick={handleImport}>
              Import Section
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        <FormField
          label="Instructions"
          description="Guide how Automated Reasoning processes this section. Describe the use case and what types of questions users will ask. Instructions are optional but help produce better results."
        >
          <Textarea
            ref={textareaRef}
            value={instructions}
            onChange={({ detail }) => setInstructions(detail.value)}
            placeholder='e.g. This section covers eligibility criteria for parental leave. Users ask questions like "Am I eligible for parental leave?"'
            rows={5}
            autoFocus
          />
        </FormField>

        <SpaceBetween size="s">
          <Button
            onClick={handleSuggest}
            loading={suggesting}
            loadingText="Analyzing your document section…"
            disabled={suggesting}
          >
            Suggest Instructions
          </Button>

          {suggestError && (
            <Alert type="info">
              We couldn't generate suggestions for this section. You can write
              your own instructions, or leave this blank to use default processing.
            </Alert>
          )}
        </SpaceBetween>
      </SpaceBetween>
    </Modal>
  );
}
