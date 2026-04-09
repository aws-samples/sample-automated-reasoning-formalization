/**
 * NewPolicyModal — Cloudscape replacement for the imperative NewPolicyForm.
 *
 * Collects policy name, source document file, and section granularity.
 */
import { useState } from "react";
import Modal from "@cloudscape-design/components/modal";
import FormField from "@cloudscape-design/components/form-field";
import Input from "@cloudscape-design/components/input";
import Button from "@cloudscape-design/components/button";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Box from "@cloudscape-design/components/box";
import Select, { type SelectProps } from "@cloudscape-design/components/select";

interface NewPolicyModalProps {
  visible: boolean;
  onDismiss: () => void;
  onCreate: (name: string, filePath: string, maxLevel: number) => void;
  openFileDialog: () => Promise<string | null>;
}

const GRANULARITY_OPTIONS: SelectProps.Option[] = [
  { value: "2", label: "By main sections" },
  { value: "3", label: "By main sections and subsections" },
];

export function NewPolicyModal({ visible, onDismiss, onCreate, openFileDialog }: NewPolicyModalProps) {
  const [name, setName] = useState("");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [granularity, setGranularity] = useState(GRANULARITY_OPTIONS[1]);

  const fileName = filePath ? filePath.split("/").pop() ?? filePath : null;
  const canCreate = name.trim().length > 0 && filePath !== null;

  const handleChooseFile = async () => {
    const path = await openFileDialog();
    if (path) setFilePath(path);
  };

  const handleCreate = () => {
    if (!canCreate || !filePath) return;
    const maxLevel = parseInt(granularity.value ?? "3", 10);
    onCreate(name.trim(), filePath, maxLevel);
    // Reset form state for next open
    setName("");
    setFilePath(null);
    setGranularity(GRANULARITY_OPTIONS[1]);
  };

  const handleDismiss = () => {
    setName("");
    setFilePath(null);
    setGranularity(GRANULARITY_OPTIONS[1]);
    onDismiss();
  };

  return (
    <Modal
      visible={visible}
      onDismiss={handleDismiss}
      header="Create New Policy"
      size="medium"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="normal" onClick={handleDismiss}>Cancel</Button>
            <Button variant="primary" disabled={!canCreate} onClick={handleCreate}>
              Create Policy
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="l">
        <FormField label="Policy Name">
          <Input
            value={name}
            onChange={({ detail }) => setName(detail.value)}
            placeholder="e.g. HR Leave Policy"
            autoFocus
          />
        </FormField>

        <FormField
          label="Source Document"
          description="Select a markdown file. You'll import sections individually after the policy is created."
        >
          <SpaceBetween direction="horizontal" size="s" alignItems="center">
            <Button onClick={handleChooseFile}>Choose File</Button>
            <Box color="text-body-secondary">
              {fileName ?? "No file selected"}
            </Box>
          </SpaceBetween>
        </FormField>

        <FormField
          label="Section Granularity"
          description="Controls how finely the document is divided for import. 'Include subsections' gives you more granular control but creates more sections to review."
        >
          <Select
            selectedOption={granularity}
            onChange={({ detail }) => setGranularity(detail.selectedOption)}
            options={GRANULARITY_OPTIONS}
          />
        </FormField>
      </SpaceBetween>
    </Modal>
  );
}
