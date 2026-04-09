/**
 * WorkspaceLayout — three-panel layout with resizable dividers.
 *
 * Renders panel shells with the legacy element IDs so existing imperative
 * components (DocumentPreview, TestPanel, ChatPanel) can attach to them.
 * Headers use Cloudscape components; bodies are empty divs for legacy code.
 *
 * The -webkit-app-region: drag on headers preserves frameless window
 * dragging behavior in Electron.
 */
import { useState, useCallback, useRef, useEffect } from "react";
import { useResizableDivider } from "../hooks/useResizableDivider";
import { TestPanel, type TestPanelHandle } from "./TestPanel";
import { DocumentPreviewPanel, type DocumentPreviewHandle } from "./DocumentPreviewPanel";
import { ChatPanelComponent, type ChatPanelHandle } from "./ChatPanelComponent";

interface WorkspaceLayoutHandle {
  toggleDoc: () => void;
  toggleTest: () => void;
}

declare global {
  interface Window {
    __workspaceLayout?: WorkspaceLayoutHandle;
  }
}

interface WorkspaceLayoutProps {
  /** Called when the layout DOM is ready for legacy components to attach. */
  onReady?: () => void;
  /** Called when the React TestPanel handle is available. */
  onTestPanelHandle?: (handle: TestPanelHandle) => void;
  /** Called when the DocumentPreview handle is available. */
  onDocPreviewHandle?: (handle: DocumentPreviewHandle) => void;
  /** Called when the ChatPanel handle is available. */
  onChatPanelHandle?: (handle: ChatPanelHandle) => void;
}

const MIN_PANEL_WIDTH = 150;
const DEFAULT_DOC_WIDTH = 300;
const DEFAULT_TEST_WIDTH = 240;

export function WorkspaceLayout({ onReady, onTestPanelHandle, onDocPreviewHandle, onChatPanelHandle }: WorkspaceLayoutProps) {
  const [docWidth, setDocWidth] = useState(DEFAULT_DOC_WIDTH);
  const [testWidth, setTestWidth] = useState(DEFAULT_TEST_WIDTH);
  const [docCollapsed, setDocCollapsed] = useState(false);
  const [testCollapsed, setTestCollapsed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const readyFired = useRef(false);

  // Signal that DOM containers are ready for legacy component attachment
  useEffect(() => {
    if (!readyFired.current) {
      readyFired.current = true;
      onReady?.();
    }
  }, [onReady]);

  const leftDivider = useResizableDivider({
    onResize: (clientX) => {
      const newWidth = Math.max(MIN_PANEL_WIDTH, Math.min(clientX, window.innerWidth - 500));
      setDocWidth(newWidth);
    },
  });

  const rightDivider = useResizableDivider({
    onResize: (clientX) => {
      const docRight = (docCollapsed ? 0 : docWidth) + 4; // 4px divider
      const newWidth = Math.max(MIN_PANEL_WIDTH, Math.min(clientX - docRight, window.innerWidth - docRight - 300));
      setTestWidth(newWidth);
    },
  });

  const toggleDoc = useCallback(() => setDocCollapsed((c) => !c), []);
  const toggleTest = useCallback(() => setTestCollapsed((c) => !c), []);

  // Expose toggle functions on the DOM for legacy code compatibility
  useEffect(() => {
    window.__workspaceLayout = { toggleDoc, toggleTest };
    return () => { window.__workspaceLayout = undefined; };
  }, [toggleDoc, toggleTest]);

  const gridColumns = [
    docCollapsed ? "0px" : `${docWidth}px`,
    "4px", // left divider
    testCollapsed ? "0px" : `${testWidth}px`,
    "4px", // right divider
    "1fr", // chat panel takes remaining space
  ].join(" ");

  return (
    <div
      ref={containerRef}
      style={{
        display: "grid",
        gridTemplateColumns: gridColumns,
        gridTemplateRows: "1fr",
        flex: 1,
        overflow: "hidden",
      }}
    >
      {/* Document panel */}
      <div
        id="document-panel"
        style={{
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          minWidth: 0,
        }}
      >
        <PanelHeader
          title="Document Preview"
          onCollapse={toggleDoc}
          collapseLabel="Collapse document panel"
          className={!docCollapsed ? "panel-header-traffic-light-inset" : undefined}
        />
        <div id="document-content" className="panel-body">
          <DocumentPreviewPanel onHandle={(h) => onDocPreviewHandle?.(h)} />
        </div>
      </div>

      {/* Left divider */}
      <Divider onMouseDown={leftDivider.onMouseDown} />

      {/* Test panel */}
      <div
        id="test-panel"
        style={{
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          minWidth: 0,
        }}
      >
        <PanelHeader
          title="Tests"
          onCollapse={toggleTest}
          collapseLabel="Collapse test panel"
          className={docCollapsed && !testCollapsed ? "panel-header-traffic-light-inset" : undefined}
          leadingActions={
            docCollapsed && !testCollapsed ? (
              <button className="btn-icon panel-expand-btn" aria-label="Expand document panel" onClick={toggleDoc}>
                <span aria-hidden="true">▶</span> <span className="panel-expand-label">Document</span>
              </button>
            ) : undefined
          }
          extraActions={
            <button
              id="btn-refresh-tests"
              className="btn-icon"
              aria-label="Refresh tests"
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            >
              ↻
            </button>
          }
        />
        <div id="test-list" className="panel-body">
          <TestPanel onHandle={(h) => onTestPanelHandle?.(h)} />
        </div>
      </div>

      {/* Right divider */}
      <Divider onMouseDown={rightDivider.onMouseDown} />

      {/* Chat panel */}
      <div
        id="chat-panel"
        style={{
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          minWidth: 0,
        }}
      >
        <ChatPanelComponent
          onHandle={(h) => onChatPanelHandle?.(h)}
          docCollapsed={docCollapsed}
          testCollapsed={testCollapsed}
          onExpandDoc={toggleDoc}
          onExpandTest={toggleTest}
        />
      </div>
    </div>
  );
}

// ── Sub-components ──

function PanelHeader({
  title,
  onCollapse,
  collapseLabel,
  leadingActions,
  extraActions,
  className,
}: {
  title: string;
  onCollapse: () => void;
  collapseLabel: string;
  leadingActions?: React.ReactNode;
  extraActions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={["panel-header", className].filter(Boolean).join(" ")}
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      {leadingActions && (
        <div className="panel-expand-buttons" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          {leadingActions}
        </div>
      )}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>
        {title}
      </span>
      <div style={{ display: "flex", gap: "0.25rem", flexShrink: 0, WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        {extraActions}
        <button
          className="btn-icon"
          aria-label={collapseLabel}
          onClick={onCollapse}
        >
          ◀
        </button>
      </div>
    </div>
  );
}

function Divider({ onMouseDown }: { onMouseDown: () => void }) {
  return (
    <div
      className="panel-divider"
      role="separator"
      aria-orientation="vertical"
      onMouseDown={onMouseDown}
    />
  );
}
