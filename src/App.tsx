/**
 * App.tsx — React root component, screen router, and modal host.
 *
 * Manages which screen is active (landing, building, workspace).
 * Landing and Building screens are React/Cloudscape components.
 * Workspace screen is still owned by the legacy imperative DOM in #app.
 *
 * Modals (PolicyPicker, NewPolicy, SectionImport) render at all times
 * since they can be triggered from any screen (e.g. SectionImport
 * is used during the workspace screen).
 */
import React, { useState, useCallback, useEffect, useRef } from "react";
import "@cloudscape-design/global-styles/index.css";
import Flashbar from "@cloudscape-design/components/flashbar";
import type { FlashbarProps } from "@cloudscape-design/components/flashbar";
import { ServiceProvider, type Services } from "./contexts/ServiceContext";
import { LandingScreen } from "./components/LandingScreen";
import { BuildingScreen } from "./components/BuildingScreen";
import { PolicyPickerModal } from "./components/PolicyPickerModal";
import { NewPolicyModal } from "./components/NewPolicyModal";
import { SectionImportModal } from "./components/SectionImportModal";
import { WorkspaceLayout } from "./components/WorkspaceLayout";
import { useCliErrors } from "./hooks/useCliErrors";
import { buildDebugSnapshot } from "./utils/debug-snapshot";
import type { TestPanelHandle } from "./components/TestPanel";
import type { DocumentPreviewHandle } from "./components/DocumentPreviewPanel";
import type { ChatPanelHandle } from "./components/ChatPanelComponent";

export type Screen = "landing" | "building" | "workspace";

export interface BuildingState {
  title: string;
  statusText: string;
  error: string | null;
}

interface SectionImportState {
  visible: boolean;
  sectionTitle: string;
  onConfirm: ((instructions: string) => void) | null;
  onSuggest: (() => Promise<string>) | null;
}

interface AppProps {
  services: Services;
  onNewPolicy: () => void;
  onOpenPolicy: () => void;
  onScreenChange: (screen: Screen) => void;
  onWorkspaceReady: () => void;
  onTestPanelHandle: (handle: TestPanelHandle) => void;
  onDocPreviewHandle: (handle: DocumentPreviewHandle) => void;
  onChatPanelHandle: (handle: ChatPanelHandle) => void;
  fetchPolicies: () => Promise<Array<{ policyArn: string; name: string; createdAt?: Date; updatedAt?: Date }>>;
  onPolicySelected: (policyArn: string, name: string) => void;
  onCreatePolicy: (name: string, filePath: string, maxLevel: number) => void;
  openFileDialog: () => Promise<string | null>;
}

/**
 * Imperative handle exposed to renderer.ts so it can drive screen
 * transitions, update building status, and show/hide modals from
 * the existing workflows. Temporary migration bridge.
 */
export interface AppHandle {
  setScreen: (screen: Screen) => void;
  setBuildingState: (state: Partial<BuildingState>) => void;
  showPolicyPicker: () => void;
  hidePolicyPicker: () => void;
  showNewPolicyForm: () => void;
  hideNewPolicyForm: () => void;
  showSectionImport: (
    sectionTitle: string,
    onConfirm: (instructions: string) => void,
    onSuggest: () => Promise<string>,
  ) => void;
  hideSectionImport: () => void;
}

declare global {
  interface Window {
    __appHandle?: AppHandle;
  }
}

export function App({
  services, onNewPolicy, onOpenPolicy, onScreenChange, onWorkspaceReady, onTestPanelHandle, onDocPreviewHandle, onChatPanelHandle,
  fetchPolicies, onPolicySelected, onCreatePolicy, openFileDialog,
}: AppProps) {
  const [screen, setScreen] = useState<Screen>("landing");
  const [building, setBuilding] = useState<BuildingState>({
    title: "Creating policy…",
    statusText: "Starting build workflow",
    error: null,
  });

  // Modal visibility
  const [pickerVisible, setPickerVisible] = useState(false);
  const [newPolicyVisible, setNewPolicyVisible] = useState(false);
  const [sectionImport, setSectionImport] = useState<SectionImportState>({
    visible: false,
    sectionTitle: "",
    onConfirm: null,
    onSuggest: null,
  });

  const changeScreen = useCallback((s: Screen) => {
    setScreen(s);
    onScreenChange(s);
  }, [onScreenChange]);

  // Stable refs for section import callbacks (avoids stale closures)
  const sectionImportRef = useRef(sectionImport);
  sectionImportRef.current = sectionImport;

  // CLI error notifications (stderr / process exit from Kiro CLI)
  const { items: cliErrorItems } = useCliErrors();

  // Debug export notifications
  const [debugFlashItems, setDebugFlashItems] = useState<FlashbarProps.MessageDefinition[]>([]);

  // Listen for Help → Download Debug Info menu trigger
  useEffect(() => {
    const cleanup = window.architect.onDebugExportRequested(async () => {
      try {
        const snapshot = buildDebugSnapshot();
        const filePath = await window.architect.exportDebugInfo(JSON.stringify(snapshot));
        if (!filePath) return; // user cancelled the save dialog
        setDebugFlashItems([{
          type: "success",
          content: `Saved to ${filePath} — share this file with support if you're reporting an issue.`,
          dismissible: true,
          onDismiss: () => setDebugFlashItems([]),
          id: "debug-export-success",
        }]);
        // Auto-dismiss after 5 seconds
        setTimeout(() => setDebugFlashItems([]), 5000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setDebugFlashItems([{
          type: "error",
          content: `Couldn't save the debug file. ${msg}`,
          dismissible: true,
          onDismiss: () => setDebugFlashItems([]),
          id: "debug-export-error",
        }]);
      }
    });
    return cleanup;
  }, []);

  // Expose imperative handle for renderer.ts (temporary migration bridge)
  useEffect(() => {
    const handle: AppHandle = {
      setScreen: changeScreen,
      setBuildingState: (patch) => setBuilding((prev) => ({ ...prev, ...patch })),
      showPolicyPicker: () => setPickerVisible(true),
      hidePolicyPicker: () => setPickerVisible(false),
      showNewPolicyForm: () => setNewPolicyVisible(true),
      hideNewPolicyForm: () => setNewPolicyVisible(false),
      showSectionImport: (title, onConfirm, onSuggest) => {
        setSectionImport({ visible: true, sectionTitle: title, onConfirm, onSuggest });
      },
      hideSectionImport: () => {
        setSectionImport({ visible: false, sectionTitle: "", onConfirm: null, onSuggest: null });
      },
    };
    window.__appHandle = handle;
    return () => { window.__appHandle = undefined; };
  }, [changeScreen]);

  return (
    <ServiceProvider services={services}>
      {(cliErrorItems.length > 0 || debugFlashItems.length > 0) && (
        <div className="cli-error-bar">
          <Flashbar items={[...debugFlashItems, ...cliErrorItems]} />
        </div>
      )}

      {screen === "landing" && (
        <LandingScreen onNewPolicy={onNewPolicy} onOpenPolicy={onOpenPolicy} />
      )}
      {screen === "building" && (
        <BuildingScreen
          title={building.title}
          statusText={building.statusText}
          error={building.error}
          onBack={() => changeScreen("landing")}
        />
      )}
      {screen === "workspace" && (
        <WorkspaceLayout
          onReady={onWorkspaceReady}
          onTestPanelHandle={onTestPanelHandle}
          onDocPreviewHandle={onDocPreviewHandle}
          onChatPanelHandle={onChatPanelHandle}
        />
      )}

      {/* Modals render at all times — they can be triggered from any screen */}
      <PolicyPickerModal
        visible={pickerVisible}
        fetchPolicies={fetchPolicies}
        onSelect={(arn, name) => {
          setPickerVisible(false);
          onPolicySelected(arn, name);
        }}
        onDismiss={() => setPickerVisible(false)}
      />

      <NewPolicyModal
        visible={newPolicyVisible}
        onDismiss={() => setNewPolicyVisible(false)}
        onCreate={(name, filePath, maxLevel) => {
          setNewPolicyVisible(false);
          onCreatePolicy(name, filePath, maxLevel);
        }}
        openFileDialog={openFileDialog}
      />

      <SectionImportModal
        visible={sectionImport.visible}
        sectionTitle={sectionImport.sectionTitle}
        onDismiss={() => {
          setSectionImport({ visible: false, sectionTitle: "", onConfirm: null, onSuggest: null });
        }}
        onConfirm={(instructions) => {
          sectionImportRef.current.onConfirm?.(instructions);
          setSectionImport({ visible: false, sectionTitle: "", onConfirm: null, onSuggest: null });
        }}
        onSuggestInstructions={async () => {
          const fn = sectionImportRef.current.onSuggest;
          if (!fn) throw new Error("No suggest handler");
          return fn();
        }}
      />
    </ServiceProvider>
  );
}
