/**
 * PolicyPickerModal — Cloudscape replacement for the imperative PolicyPicker.
 *
 * Displays a modal with loading, table, empty, and error states.
 * Single-click row selection (no radio buttons).
 */
import { useState, useEffect, useCallback, useMemo } from "react";
import Modal from "@cloudscape-design/components/modal";
import Table from "@cloudscape-design/components/table";
import TextFilter from "@cloudscape-design/components/text-filter";
import Button from "@cloudscape-design/components/button";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Box from "@cloudscape-design/components/box";
import Spinner from "@cloudscape-design/components/spinner";
import Alert from "@cloudscape-design/components/alert";

interface PolicyItem {
  policyArn: string;
  name: string;
  createdAt?: Date;
  updatedAt?: Date;
}

type PickerState =
  | { status: "loading" }
  | { status: "loaded"; policies: PolicyItem[] }
  | { status: "error"; message: string };

interface PolicyPickerModalProps {
  visible: boolean;
  fetchPolicies: () => Promise<PolicyItem[]>;
  onSelect: (policyArn: string, name: string) => void;
  onDismiss: () => void;
}

function formatDate(date?: Date): string {
  if (!date) return "—";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function PolicyPickerModal({ visible, fetchPolicies, onSelect, onDismiss }: PolicyPickerModalProps) {
  const [state, setState] = useState<PickerState>({ status: "loading" });
  const [filterText, setFilterText] = useState("");

  const loadPolicies = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const policies = await fetchPolicies();
      setState({ status: "loaded", policies });
    } catch (err) {
      // fetchPolicies rejects with Error instances
      setState({ status: "error", message: (err as Error).message });
    }
  }, [fetchPolicies]);

  useEffect(() => {
    if (visible) {
      setFilterText("");
      loadPolicies();
    }
  }, [visible, loadPolicies]);

  const filteredPolicies = useMemo(() => {
    if (state.status !== "loaded") return [];
    if (!filterText.trim()) return state.policies;
    const needle = filterText.trim().toLowerCase();
    return state.policies.filter((p) => p.name.toLowerCase().includes(needle));
  }, [state, filterText]);

  function filterCountText(count: number, total: number): string {
    if (!filterText.trim()) return `${total} policies`;
    return count === 1 ? "1 match" : `${count} matches`;
  }

  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      header="Select a policy"
      size="medium"
      footer={
        <Box float="right">
          <Button variant="normal" onClick={onDismiss}>Cancel</Button>
        </Box>
      }
    >
      {state.status === "loading" && (
        <Box textAlign="center" padding="l">
          <SpaceBetween size="s" alignItems="center">
            <Spinner size="large" />
            <Box color="text-body-secondary">Finding your policies…</Box>
          </SpaceBetween>
        </Box>
      )}

      {state.status === "error" && (
        <SpaceBetween size="m">
          <Alert type="error" header="We couldn't load your policies">
            This might be a temporary connection issue. Try again, and if it
            keeps happening, check your network connection.
          </Alert>
          <Button onClick={loadPolicies}>Retry</Button>
        </SpaceBetween>
      )}

      {state.status === "loaded" && state.policies.length === 0 && (
        <Box textAlign="center" padding="l" color="text-body-secondary">
          <SpaceBetween size="s">
            <Box variant="p" fontWeight="bold">No policies yet</Box>
            <Box variant="p">
              Close this dialog and click "Import Document" to get started.
            </Box>
          </SpaceBetween>
        </Box>
      )}

      {state.status === "loaded" && state.policies.length > 0 && (
        <div className="policy-picker-table">
          <Table
            items={filteredPolicies}
            columnDefinitions={[
              {
                id: "name",
                header: "Name",
                cell: (item) => item.name,
              },
              {
                id: "lastModified",
                header: "Last modified",
                cell: (item) => formatDate(item.updatedAt ?? item.createdAt),
                width: 150,
              },
            ]}
            filter={
              <TextFilter
                filteringPlaceholder="Find a policy by name"
                filteringText={filterText}
                onChange={({ detail }) => setFilterText(detail.filteringText)}
                countText={filterCountText(filteredPolicies.length, state.policies.length)}
              />
            }
            empty={
              <Box textAlign="center" padding="l" color="text-body-secondary">
                <SpaceBetween size="s">
                  <Box variant="p" fontWeight="bold">{`No policies match "${filterText}"`}</Box>
                  <Box variant="p">
                    Try a different name, or{" "}
                    <Button variant="inline-link" onClick={() => setFilterText("")}>clear the filter</Button>{" "}
                    to see all your policies.
                  </Box>
                </SpaceBetween>
              </Box>
            }
            onRowClick={({ detail }) => {
              onSelect(detail.item.policyArn, detail.item.name);
            }}
            variant="embedded"
            stripedRows
          />
        </div>
      )}
    </Modal>
  );
}
