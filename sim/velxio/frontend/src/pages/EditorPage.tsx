/**
 * Editor Page — main editor + simulator with resizable panels
 */

import React, { useRef, useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { startSimulation } from '../simulation/spice/start';
import { useDocumentTitle } from '../utils/useDocumentTitle';
import { getLocaleFromPath, localizedPath } from '../i18n/path';
import {
  openSavedProject,
  restoreWorkspace,
  savedProjectParam,
} from '../utils/workspacePersistence';
import { ProjectsHost } from '../components/projects/ProjectsHost';
import { loadProjectFromUrl, projectParam } from '../utils/loadFromUrl';
import { showMessageDialog } from '../store/useMessageDialogStore';
import { CodeEditor } from '../components/editor/CodeEditor';
import { EditorToolbar } from '../components/editor/EditorToolbar';
import { FileExplorer } from '../components/editor/FileExplorer';

// Lazy-load Pi workspace so xterm.js isn't in the main bundle
import { CompilationConsole } from '../components/editor/CompilationConsole';
import { CompileProgressCard } from '../components/editor/CompileProgressCard';
import { SimulatorCanvas } from '../components/simulator/SimulatorCanvas';
import { SerialMonitor } from '../components/simulator/SerialMonitor';
import { Oscilloscope } from '../components/simulator/Oscilloscope';
import { AppHeader } from '../components/layout/AppHeader';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useEditorStore } from '../store/useEditorStore';
import { EditorStatusBar } from '../components/layout/EditorStatusBar';
import { useCompileLogsStore } from '../store/useCompileLogsStore';
import { useOscilloscopeStore } from '../store/useOscilloscopeStore';
import { useProjectStore } from '../store/useProjectStore';
import {
  NewProjectDialog,
  clearWorkspaceForStarter,
} from '../components/editor/NewProjectDialog';
import { useWorkspaceDraft } from '../hooks/useWorkspaceDraft';
import { registerEditorCommand, runEditorCommand } from '../lib/editorCommands';
import { EditorMenuBar } from '../components/editor/EditorMenuBar';
import type { CompilationLog } from '../utils/compilationLogger';
import '../App.css';

const MOBILE_BREAKPOINT = 768;

const BOTTOM_PANEL_MIN = 80;
const BOTTOM_PANEL_MAX = 600;
const BOTTOM_PANEL_DEFAULT = 200;

const EXPLORER_MIN = 100;
const EXPLORER_MAX = 500;
// Narrow by default: the explorer rows are compact and both headers stack
// their actions ABOVE their label instead of beside it (see
// FileExplorer.css), so nothing has to share a line — 124px fits a board
// name and typical file names, and every px saved here goes to the code
// editor.
const EXPLORER_DEFAULT = 184;

// Once per full page load: the `?project=` load, the draft restore and the
// pristine-visit starter dialog must not run again when the user later
// navigates away from and back to /editor within the same SPA session.
let workspaceInitDoneThisLoad = false;

const resizeHandleStyle: React.CSSProperties = {
  height: 5,
  flexShrink: 0,
  cursor: 'row-resize',
  background: 'var(--wb-5)',
  borderTop: '1px solid var(--wb-7)',
  borderBottom: '1px solid var(--wb-7)',
};

export const EditorPage: React.FC = () => {
  const { t } = useTranslation();
  useDocumentTitle('keybordy');

  // Local draft autosave; armed once the workspace init below has decided
  // what the canvas shows.
  const [draftReady, setDraftReady] = useState(workspaceInitDoneThisLoad);
  const autoSave = useWorkspaceDraft(draftReady);

  const [editorWidthPct, setEditorWidthPct] = useState(45);
  // Desktop-only 3-way layout switch (code-only / circuit-only / both).
  // Lets users hide a pane to give the right-docked chat more room.
  const viewMode = useEditorStore((s) => s.viewMode);
  const setViewMode = useEditorStore((s) => s.setViewMode);
  const explorerOpen = useEditorStore((s) => s.explorerOpen);
  const setExplorerOpen = useEditorStore((s) => s.setExplorerOpen);
  const toggleExplorer = useEditorStore((s) => s.toggleExplorer);
  const containerRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef(false);
  const serialMonitorOpen = useSimulatorStore((s) => s.serialMonitorOpen);
  const activeBoardId = useSimulatorStore((s) => s.activeBoardId);
  const oscilloscopeOpen = useOscilloscopeStore((s) => s.open);
  const [consoleOpen, setConsoleOpen] = useState(false);
  // compileLogs live in a Zustand store so any consumer can subscribe
  // without prop-drilling.
  const compileLogs = useCompileLogsStore((s) => s.logs);
  const setCompileLogs = useCompileLogsStore((s) => s.setLogs);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(BOTTOM_PANEL_DEFAULT);

  // ── Electrical simulation (one-time mount) ────────────────────────────────
  // `startSimulation()` is the single entry point: it constructs the
  // CircuitSimulationService, mounts the ADC bridge, and subscribes
  // PinManager → service.handleMcuEdge.  No more legacy paths — the
  // WASM ngspice (via NgSpiceWorkerAdapter) is the only solver.
  useEffect(() => {
    return startSimulation();
  }, []);

  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false);

  // What the canvas shows on arrival, in order:
  //   0. `/editor?id=<uuid>`: a saved project from the server (Postgres);
  //   1. `/editor?project=<name>`: the project folder served at /projects/
  //      (re-read on every load, so the files on disk stay the truth);
  //   2. plain `/editor`: the saved project open last, else the local draft;
  //   3. otherwise, on the untouched default canvas (the hardcoded Uno + LED
  //      of useSimulatorStore's INITIAL_BOARD), the starter-template picker
  //      over an emptied canvas (cancelling leaves a blank workspace).
  // Example routes (/example/<id>) load their own workspace and skip all
  // three. The draft autosave is armed only after this has run.
  useEffect(() => {
    if (workspaceInitDoneThisLoad) return;
    workspaceInitDoneThisLoad = true;
    const locale = getLocaleFromPath(window.location.pathname);
    const onEditor =
      window.location.pathname.replace(/\/+$/, '') === localizedPath('/editor', locale);
    const init = async () => {
      if (!onEditor) return;
      const savedId = savedProjectParam();
      if (savedId) {
        const result = await openSavedProject(savedId);
        if (result === 'not-found' || result === 'unavailable') {
          showMessageDialog(
            result === 'not-found'
              ? 'That saved project no longer exists.'
              : 'The project store is unreachable and this browser has no copy of that project.',
            { kind: 'error' },
          );
        }
        return;
      }
      const project = projectParam();
      if (project) {
        try {
          const warnings = await loadProjectFromUrl(project);
          for (const w of warnings) console.warn(`[project] ${w}`);
        } catch (err) {
          showMessageDialog(
            `Could not load project "${project}": ${err instanceof Error ? err.message : String(err)}`,
            { kind: 'error' },
          );
        }
        return;
      }
      if (window.location.search) return;
      if (await restoreWorkspace()) return;
      if (useProjectStore.getState().currentProject) return;
      const sim = useSimulatorStore.getState();
      const pristine =
        sim.boards.length === 1 &&
        sim.boards[0].id === 'arduino-uno' &&
        sim.components.length === 2 &&
        sim.components.every((c) => c.id === 'led_builtin' || c.id === 'r_builtin');
      if (!pristine) return;
      clearWorkspaceForStarter();
      setShowNewProjectDialog(true);
    };
    void init().finally(() => setDraftReady(true));
  }, []);

  const [explorerWidth, setExplorerWidth] = useState(EXPLORER_DEFAULT);
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches,
  );
  // Slot element for SimulatorCanvas to portal its header into. When set, the
  // canvas board selector / Serial / Scope / zoom / Add buttons render here
  // instead of above the canvas — keeping the top bar a single full-width row
  // that doesn't reflow when the editor/canvas splitter is dragged.
  const [canvasHeaderSlot, setCanvasHeaderSlot] = useState<HTMLDivElement | null>(null);
  // Default to 'code' on mobile — show the editor so users can write/view code
  const [mobileView, setMobileView] = useState<'code' | 'circuit'>('code');

  // Mirrors the `display: none` on the simulator panel below. The compile
  // progress card renders over the canvas, so when that pane is hidden the
  // card has to move to the editor pane instead of disappearing with it.
  const simulatorHidden =
    (isMobile && mobileView !== 'circuit') || (!isMobile && viewMode === 'code');

  // The workspace autosaves to the local draft; Save downloads it as a
  // Wokwi .zip (diagram.json + sources), the layout of a firmware/<name>/
  // project folder. Export .vlx in the File menu keeps multi-board projects.
  const handleSaveClick = useCallback(() => {
    runEditorCommand('project.export');
  }, []);

  // "New workspace" opens the starter-template dialog. Destruction moved
  // from here into the dialog's selection handler — Cancel/ESC now leaves
  // the current workspace untouched, so the old confirm dialog is gone.
  const handleNewClick = useCallback(() => {
    setShowNewProjectDialog(true);
  }, []);

  // Track mobile breakpoint
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`);
    const update = (e: MediaQueryListEvent | MediaQueryList) => {
      const mobile = e.matches;
      setIsMobile(mobile);
      if (mobile) setExplorerOpen(false);
    };
    update(mq);
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [setExplorerOpen]);

  // Ctrl+S shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSaveClick();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSaveClick]);

  // File-menu commands owned by this page. Registered here (not in the
  // menu) so the menu never duplicates the confirm-dialog / autosave logic.
  useEffect(() => {
    const offSave = registerEditorCommand('project.save', handleSaveClick);
    const offNew = registerEditorCommand('project.new', () => {
      void handleNewClick();
    });
    const offExplorer = registerEditorCommand('view.toggleExplorer', () => toggleExplorer());
    return () => {
      offSave();
      offNew();
      offExplorer();
    };
  }, [handleSaveClick, handleNewClick, toggleExplorer]);

  // Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z — canvas undo/redo. Skipped when the
  // user is typing in any input/textarea/contenteditable so the Monaco
  // editor's per-file history (and the AI chat composer, etc.) keep
  // working untouched.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) {
          return;
        }
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      const sim = useSimulatorStore.getState();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        sim.undo();
      } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault();
        sim.redo();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Prevent body scroll on the editor page
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    window.scrollTo(0, 0);
    return () => {
      html.style.overflow = '';
      body.style.overflow = '';
    };
  }, []);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;

    const handleMouseMove = (ev: MouseEvent) => {
      if (!resizingRef.current || !containerRef.current) return;
      const el = containerRef.current;
      const rect = el.getBoundingClientRect();
      // The panels' percentage widths resolve against the container's CONTENT
      // box, but getBoundingClientRect() returns the border box — and overlays
      // may reserve space by padding .app-container (e.g. a docked side panel).
      // Measuring against the padded box makes the handle jump away from the
      // cursor, so strip borders and padding first.
      const cs = getComputedStyle(el);
      const padLeft = parseFloat(cs.paddingLeft) || 0;
      const padRight = parseFloat(cs.paddingRight) || 0;
      const contentLeft = rect.left + el.clientLeft + padLeft;
      const contentWidth = el.clientWidth - padLeft - padRight;
      if (contentWidth <= 0) return;
      const pct = ((ev.clientX - contentLeft) / contentWidth) * 100;
      setEditorWidthPct(Math.max(20, Math.min(80, pct)));
    };

    const handleMouseUp = () => {
      resizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  const handleBottomPanelResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = bottomPanelHeight;

      const onMove = (ev: MouseEvent) => {
        const delta = startY - ev.clientY;
        setBottomPanelHeight(
          Math.max(BOTTOM_PANEL_MIN, Math.min(BOTTOM_PANEL_MAX, startHeight + delta)),
        );
      };
      const onUp = () => {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [bottomPanelHeight],
  );

  const handleExplorerResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = explorerWidth;

      const onMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        setExplorerWidth(Math.max(EXPLORER_MIN, Math.min(EXPLORER_MAX, startWidth + delta)));
      };
      const onUp = () => {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [explorerWidth],
  );

  /* ── Unified toolbar (desktop) ──
     Editor controls + canvas controls in one strip; the canvas side is
     portaled into `canvasHeaderSlot` from SimulatorCanvas. Since the
     marketing nav left the editor header, the header's middle is empty
     space — so this strip now rides INSIDE the AppHeader row (via the
     editorToolbar prop) instead of being a second bar: one 44px row where
     there used to be 44+38. On narrow widths the strip wraps internally
     and the header grows; the docked AI chat is avoided by the same
     padding-right the strip always had. */
  const unifiedToolbar = !isMobile ? (
        <div className="unified-toolbar">
          {/* View-mode toggle: explorer | Code / Both / Circuit — one
              segmented group so the four pane switches read as one control.
              Hidden on mobile — there's already a code/circuit toggle in
              the mobile bottom-nav. */}
          <div
            role="group"
            aria-label={t('editor.shell.viewMode')}
            className="view-mode-toggle"
          >
            <button
              onClick={() => toggleExplorer()}
              aria-pressed={explorerOpen}
              title={explorerOpen ? t('editor.menu.hideExplorer', 'Hide file explorer') : t('editor.menu.showExplorer', 'Show file explorer')}
              className="vm-seg"
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </button>
            <div className="vm-divider" />
            {(
              [
                { key: 'code', label: t('editor.shell.code'), path: 'M16 18l6-6-6-6M8 6l-6 6 6 6' },
                { key: 'both', label: t('editor.shell.both'), path: 'M3 3h7v18H3zM14 3h7v18h-7z' },
                { key: 'circuit', label: t('editor.shell.circuit'), path: 'M5 12h14M12 5v14' },
              ] as const
            ).map((m) => (
              <button
                key={m.key}
                onClick={() => setViewMode(m.key)}
                aria-pressed={viewMode === m.key}
                className="vm-seg"
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d={m.path} />
                </svg>
                <span className="vm-label">{m.label}</span>
              </button>
            ))}
          </div>
          <div className="unified-toolbar-editor">
            <EditorToolbar
              consoleOpen={consoleOpen}
              setConsoleOpen={setConsoleOpen}
              compileLogs={compileLogs}
              setCompileLogs={setCompileLogs}
            />
          </div>
          <div className="unified-toolbar-canvas" ref={setCanvasHeaderSlot} />
        </div>
  ) : undefined;

  return (
    <div className="app">
      <AppHeader
        editorMenu={!isMobile ? <EditorMenuBar /> : undefined}
        editorToolbar={unifiedToolbar}
      />

      {/* ── Mobile tab bar (top, above panels) ── */}
      {isMobile && (
        <nav className="mobile-tab-bar">
          <button
            className={`mobile-tab-btn${mobileView === 'code' ? ' mobile-tab-btn--active' : ''}`}
            onClick={() => setMobileView('code')}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="16 18 22 12 16 6" />
              <polyline points="8 6 2 12 8 18" />
            </svg>
            <span>&lt;/&gt; {t('editor.shell.code')}</span>
          </button>
          <button
            className={`mobile-tab-btn${mobileView === 'circuit' ? ' mobile-tab-btn--active' : ''}`}
            onClick={() => setMobileView('circuit')}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="2" y="7" width="20" height="14" rx="2" />
              <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
              <line x1="12" y1="12" x2="12" y2="16" />
              <line x1="10" y1="14" x2="14" y2="14" />
            </svg>
            <span>{t('editor.shell.circuit')}</span>
          </button>
        </nav>
      )}


      <div className="app-container" ref={containerRef}>
        {/* ── Editor side ── */}
        <div
          className="editor-panel"
          style={{
            width: isMobile
              ? '100%'
              : viewMode === 'code'
              ? '100%'
              : viewMode === 'circuit'
              ? '0%'
              : `${editorWidthPct}%`,
            display:
              (isMobile && mobileView !== 'code') || (!isMobile && viewMode === 'circuit')
                ? 'none'
                : 'flex',
            flexDirection: 'row',
          }}
        >
          {/* File explorer sidebar + resize handle */}
          {explorerOpen && (
            <>
              <div
                style={{
                  width: explorerWidth,
                  flexShrink: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                }}
              >
                <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
                  <FileExplorer onSaveClick={handleSaveClick} onNewClick={handleNewClick} autoSave={autoSave} />
                </div>
              </div>
              {!isMobile && (
                <div
                  className="explorer-resize-handle"
                  onMouseDown={handleExplorerResizeMouseDown}
                />
              )}
            </>
          )}

          {/* Editor main area */}
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              minWidth: 0,
            }}
          >
            {/* Mobile-only: explorer toggle + editor toolbar inside the panel.
                On desktop these are hoisted into the unified top toolbar. */}
            {isMobile && (
              <div style={{ display: 'flex', alignItems: 'stretch', flexShrink: 0 }}>
                <button
                  className="explorer-toggle-btn"
                  onClick={() => toggleExplorer()}
                  title={explorerOpen ? t('editor.menu.hideExplorer', 'Hide file explorer') : t('editor.menu.showExplorer', 'Show file explorer')}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <EditorToolbar
                    consoleOpen={consoleOpen}
                    setConsoleOpen={setConsoleOpen}
                    compileLogs={compileLogs}
                    setCompileLogs={setCompileLogs}
                  />
                </div>
              </div>
            )}

            {/* Editor area — Monaco for every board, QEMU-Linux included.
                Pi boards edit script.py here like any other board edits its
                sketch; their interactive terminal lives in the bottom serial
                panel (SerialMonitor renders an xterm for Pi kinds). The old
                RaspberryPiWorkspace (own file tree + own editor + upload
                button) confused users with three competing file surfaces. */}
            <div
              className="editor-wrapper"
              style={{ flex: 1, overflow: 'hidden', minHeight: 0, position: 'relative' }}
            >
              <CodeEditor />
              {/* The compile card lives over the simulator canvas, which is
                  where the build's result appears. In code-only view (and on
                  a phone showing the editor) that pane is display:none, so it
                  falls back to here rather than leaving the user with the
                  toolbar spinner and no idea a queue exists. */}
              {simulatorHidden && (
                <CompileProgressCard inEditor onShowOutput={() => setConsoleOpen(true)} />
              )}
            </div>

            {/* Console */}
            {consoleOpen && (
              <>
                <div
                  onMouseDown={handleBottomPanelResizeMouseDown}
                  style={resizeHandleStyle}
                  title={t('editor.shell.dragResize')}
                />
                <div style={{ height: bottomPanelHeight, flexShrink: 0 }}>
                  <CompilationConsole
                    isOpen={consoleOpen}
                    onClose={() => setConsoleOpen(false)}
                    logs={compileLogs}
                    onClear={() => setCompileLogs([])}
                  />
                </div>
              </>
            )}
          </div>
        </div>

        {/* Resize handle (desktop only, and only when both panes are visible) */}
        {!isMobile && viewMode === 'both' && (
          <div className="resize-handle" onMouseDown={handleResizeMouseDown}>
            <div className="resize-handle-grip" />
          </div>
        )}

        {/* ── Simulator side ── */}
        <div
          className="simulator-panel"
          style={{
            width: isMobile
              ? '100%'
              : viewMode === 'circuit'
              ? '100%'
              : viewMode === 'code'
              ? '0%'
              : `${100 - editorWidthPct}%`,
            display: simulatorHidden ? 'none' : 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0 }}>
            <SimulatorCanvas headerSlot={!isMobile ? canvasHeaderSlot : null} />
            {/* Guarded rather than left to `display: none` on the panel: a
                hidden copy still keeps its 100ms timer running and duplicates
                the aria-live region a screen reader reads out. */}
            {!simulatorHidden && <CompileProgressCard onShowOutput={() => setConsoleOpen(true)} />}
          </div>
          {serialMonitorOpen && (
            <>
              <div
                onMouseDown={handleBottomPanelResizeMouseDown}
                style={resizeHandleStyle}
                title={t('editor.shell.dragResize')}
              />
              <div style={{ height: bottomPanelHeight, flexShrink: 0 }}>
                <SerialMonitor />
              </div>
            </>
          )}
          {oscilloscopeOpen && (
            <>
              <div
                onMouseDown={handleBottomPanelResizeMouseDown}
                style={resizeHandleStyle}
                title={t('editor.shell.dragResize')}
              />
              <div style={{ height: bottomPanelHeight, flexShrink: 0 }}>
                <Oscilloscope />
              </div>
            </>
          )}
        </div>
      </div>

      {!isMobile && <EditorStatusBar />}

      <NewProjectDialog
        isOpen={showNewProjectDialog}
        onClose={() => setShowNewProjectDialog(false)}
      />
      <ProjectsHost />
    </div>
  );
};
