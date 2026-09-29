/**
 * EditorMenuBar — File / Edit menus for the editor header.
 *
 * The editor grew a single toolbar row where every action, frequent or
 * rare, competed for the same pixels; on small screens the buttons
 * measurably overlapped. The classic fix is the classic desktop split:
 * things you do every minute stay as buttons (Run, Stop, board, Add),
 * things you do a few times per session move into menus. This is those
 * menus.
 *
 * Actions are invoked through the editorCommands registry — their real
 * owners (EditorPage, FileExplorer, EditorToolbar, SimulatorCanvas)
 * register handlers on mount, so nothing here duplicates logic and an
 * item whose owner is not mounted renders disabled. Undo/redo read the
 * canvas history from the store directly, mirroring the canvas buttons.
 *
 * Menubar behaviour follows the desktop convention: click opens, click
 * again closes, hovering a sibling while open switches menus, Escape and
 * outside clicks close.
 */
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { useOscilloscopeStore } from '../../store/useOscilloscopeStore';
import { useEditorStore, type EditorViewMode } from '../../store/useEditorStore';
import { useThemeMode } from '../../hooks/useTheme';
import type { ThemeMode } from '../../lib/theme';
import { LOCALES, LOCALE_META, type Locale } from '../../i18n/config';
import { getLocaleFromPath, switchLocale } from '../../i18n/path';
import {
  hasEditorCommand,
  runEditorCommand,
  subscribeEditorCommands,
  getEditorCommandsVersion,
  type EditorCommandId,
} from '../../lib/editorCommands';
import './EditorMenuBar.css';

type Item =
  | {
      kind: 'command';
      id: EditorCommandId;
      label: string;
      shortcut?: string;
      /** Hide the row entirely when no handler is registered, instead of
       *  the default "render disabled". */
      optional?: boolean;
    }
  | { kind: 'link'; href: string; label: string }
  | { kind: 'separator' };

// Upstream project links, opening in a new tab so the editor (and any
// unsaved work) stays put.
const GITHUB_URL = 'https://github.com/davidmonterocrespo24/velxio';
const DISCORD_URL = 'https://discord.gg/3mARjJrh4E';

export const EditorMenuBar: React.FC = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState<'file' | 'edit' | 'view' | 'language' | 'help' | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Re-render when owners (un)register their commands.
  useSyncExternalStore(subscribeEditorCommands, getEditorCommandsVersion);

  const location = useLocation();
  const navigate = useNavigate();
  const currentLocale = getLocaleFromPath(location.pathname);
  const serialOpen = useSimulatorStore((s) => s.serialMonitorOpen);
  const toggleSerialMonitor = useSimulatorStore((s) => s.toggleSerialMonitor);
  const scopeOpen = useOscilloscopeStore((s) => s.open);
  const toggleOscilloscope = useOscilloscopeStore((s) => s.toggleOscilloscope);
  // Layout rows: the same switches as the toolbar's explorer / Code / Both /
  // Circuit toggle, which hides on a narrow bar (App.css) — the menu is then
  // the only way to reach them, so they carry live checkmarks.
  const explorerOpen = useEditorStore((s) => s.explorerOpen);
  const toggleExplorer = useEditorStore((s) => s.toggleExplorer);
  const viewMode = useEditorStore((s) => s.viewMode);
  const setViewMode = useEditorStore((s) => s.setViewMode);
  const [themeMode, setThemeMode] = useThemeMode();
  const undo = useSimulatorStore((s) => s.undo);
  const redo = useSimulatorStore((s) => s.redo);
  const history = useSimulatorStore((s) => s.history);
  const historyIndex = useSimulatorStore((s) => s.historyIndex);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const fileItems: Item[] = [
    { kind: 'command', id: 'project.new', label: t('editor.menu.newProject', 'New workspace') },
    { kind: 'command', id: 'file.new', label: t('editor.menu.newFile', 'New file') },
    { kind: 'separator' },
    { kind: 'command', id: 'project.open', label: t('editor.menu.open', 'Open project…') },
    { kind: 'command', id: 'project.browse', label: t('editor.menu.projects', 'Projects…') },
    { kind: 'command', id: 'project.saveAs', label: t('editor.menu.saveToProjects', 'Save to projects…') },
    {
      kind: 'command',
      id: 'project.save',
      label: t('editor.menu.save', 'Save project'),
      shortcut: 'Ctrl+S',
    },
    { kind: 'separator' },
    { kind: 'command', id: 'project.import', label: t('editor.toolbar.importLabel', 'Import project') },
    { kind: 'command', id: 'project.exportVlx', label: t('editor.toolbar.exportVlxLabel', 'Export project (.vlx)') },
    { kind: 'command', id: 'project.export', label: t('editor.toolbar.exportLabel', 'Export project (.zip)') },
    { kind: 'separator' },
    { kind: 'command', id: 'firmware.upload', label: t('editor.toolbar.uploadFirmwareLabel', 'Upload firmware') },
  ];

  const helpItems: Item[] = [
    { kind: 'link', href: '/examples', label: t('header.nav.examples', 'Examples') },
    { kind: 'separator' },
    { kind: 'link', href: DISCORD_URL, label: t('editor.menu.discord', 'Discord Community') },
    { kind: 'link', href: GITHUB_URL, label: t('editor.menu.github', 'GitHub Repository') },
  ];

  // Undo/redo render specially above (live canvas history state); the rest
  // of Edit is the code editor's own actions. Everything view-shaped lives
  // in the View menu, like the desktop app.
  const editItems: Item[] = [
    { kind: 'separator' },
    {
      kind: 'command',
      id: 'edit.formatDocument',
      label: t('editor.menu.formatDocument', 'Format document'),
      shortcut: 'Shift+Alt+F',
    },
  ];

  // File Explorer is rendered as a checkmarked row in the View block below
  // (it reads the store), not as a plain command here.
  const viewItems: Item[] = [
    { kind: 'command', id: 'sim.compile', label: t('editor.menu.compile', 'Compile'), shortcut: 'Ctrl+B' },
    { kind: 'command', id: 'sim.run', label: t('editor.menu.run', 'Run') },
    { kind: 'command', id: 'sim.stop', label: t('editor.toolbar.stop', 'Stop') },
    { kind: 'command', id: 'sim.resetBoard', label: t('editor.toolbar.reset', 'Reset') },
    { kind: 'separator' },
    { kind: 'command', id: 'view.toggleConsole', label: t('editor.menu.toggleConsole', 'Output Console') },
    { kind: 'separator' },
    { kind: 'command', id: 'view.reset', label: t('editor.menu.centerView', 'Center canvas view') },
    { kind: 'command', id: 'view.zoomIn', label: t('editor.canvas.zoomIn', 'Zoom in') },
    { kind: 'command', id: 'view.zoomOut', label: t('editor.canvas.zoomOut', 'Zoom out') },
  ];

  const themeModes: { key: ThemeMode; label: string }[] = [
    { key: 'dark', label: t('editor.menu.themeDark', 'Dark') },
    { key: 'light', label: t('editor.menu.themeLight', 'Light') },
    { key: 'system', label: t('editor.menu.themeSystem', 'Match system') },
  ];

  const layoutModes: { key: EditorViewMode; label: string }[] = [
    { key: 'code', label: t('editor.shell.code', 'Code') },
    { key: 'both', label: t('editor.shell.both', 'Both') },
    { key: 'circuit', label: t('editor.shell.circuit', 'Circuit') },
  ];

  const renderLink = (item: Extract<Item, { kind: 'link' }>): React.ReactNode => (
    <a
      key={item.href}
      role="menuitem"
      className="emb-item"
      href={item.href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => setOpen(null)}
    >
      <span>{item.label}</span>
    </a>
  );

  const renderCommand = (item: Extract<Item, { kind: 'command' }>): React.ReactNode => (
    <button
      key={item.id}
      role="menuitem"
      className="emb-item"
      disabled={!hasEditorCommand(item.id)}
      onClick={() => {
        setOpen(null);
        runEditorCommand(item.id);
      }}
    >
      <span>
        {item.label}
      </span>
      {item.shortcut && <span className="emb-shortcut">{item.shortcut}</span>}
    </button>
  );

  const menu = (which: 'file' | 'edit' | 'view' | 'language' | 'help', label: string, items: Item[]): React.ReactNode => (
    <div className="emb-root" key={which}>
      <button
        className={`emb-trigger${open === which ? ' emb-trigger-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open === which}
        onClick={() => setOpen((cur) => (cur === which ? null : which))}
        onMouseEnter={() => setOpen((cur) => (cur && cur !== which ? which : cur))}
      >
        {label}
      </button>
      {open === which && (
        <div className="emb-menu" role="menu">
          {which === 'view' && (
            <>
              <button
                role="menuitemcheckbox"
                aria-checked={serialOpen}
                className="emb-item"
                onClick={() => {
                  setOpen(null);
                  toggleSerialMonitor();
                }}
              >
                <span>{t('editor.canvas.toggleSerialMonitor', 'Serial Monitor')}</span>
                <span className="emb-shortcut">{serialOpen ? '✓' : ''}</span>
              </button>
              <button
                role="menuitemcheckbox"
                aria-checked={scopeOpen}
                className="emb-item"
                onClick={() => {
                  setOpen(null);
                  toggleOscilloscope();
                }}
              >
                <span>{t('editor.menu.toggleScope', 'Oscilloscope / Logic Analyzer')}</span>
                <span className="emb-shortcut">{scopeOpen ? '✓' : ''}</span>
              </button>
              <div className="emb-separator" />
              {/* Layout: explorer pane + Code / Both / Circuit. Mirrors the
                  toolbar's segmented toggle, which App.css hides once the
                  shared bar gets narrow (small window + docked AI chat). */}
              <div className="emb-section-label">{t('editor.shell.viewMode', 'View mode')}</div>
              <button
                role="menuitemcheckbox"
                aria-checked={explorerOpen}
                className="emb-item"
                onClick={() => {
                  setOpen(null);
                  toggleExplorer();
                }}
              >
                <span>{t('editor.menu.toggleExplorer', 'File Explorer')}</span>
                <span className="emb-shortcut">{explorerOpen ? '✓' : ''}</span>
              </button>
              {layoutModes.map((m) => (
                <button
                  key={m.key}
                  role="menuitemradio"
                  aria-checked={viewMode === m.key}
                  className="emb-item"
                  onClick={() => {
                    setOpen(null);
                    setViewMode(m.key);
                  }}
                >
                  <span>{m.label}</span>
                  <span className="emb-shortcut">{viewMode === m.key ? '✓' : ''}</span>
                </button>
              ))}
              <div className="emb-separator" />
              {/* Appearance. Not an editor setting — the choice is stored per
                  origin and the blog and docs portal read the same key, so
                  flipping it here flips velxio.dev. "System" is opt-in, never
                  the default: an unset preference is dark. */}
              <div className="emb-section-label">
                {t('editor.menu.appearance', 'Appearance')}
              </div>
              {themeModes.map((m) => (
                <button
                  key={m.key}
                  role="menuitemradio"
                  aria-checked={themeMode === m.key}
                  className="emb-item"
                  onClick={() => {
                    setOpen(null);
                    setThemeMode(m.key);
                  }}
                >
                  <span>{m.label}</span>
                  <span className="emb-shortcut">{themeMode === m.key ? '✓' : ''}</span>
                </button>
              ))}
              <div className="emb-separator" />
            </>
          )}
          {which === 'language' && (
            <>
              {LOCALES.map((loc) => (
                <button
                  key={loc}
                  role="menuitemradio"
                  aria-checked={currentLocale === loc}
                  className="emb-item"
                  onClick={() => {
                    setOpen(null);
                    if (loc === currentLocale) return;
                    navigate(
                      switchLocale(location.pathname, loc as Locale) +
                        location.search +
                        location.hash,
                    );
                  }}
                >
                  <span>{LOCALE_META[loc].nativeName}</span>
                  <span className="emb-shortcut">{currentLocale === loc ? '✓' : ''}</span>
                </button>
              ))}
            </>
          )}
          {which === 'edit' && (
            <>
              <button
                role="menuitem"
                className="emb-item"
                disabled={historyIndex < 0}
                onClick={() => {
                  setOpen(null);
                  undo();
                }}
              >
                <span>{t('editor.menu.undo', 'Undo')}</span>
                <span className="emb-shortcut">Ctrl+Z</span>
              </button>
              <button
                role="menuitem"
                className="emb-item"
                disabled={historyIndex >= history.length - 1}
                onClick={() => {
                  setOpen(null);
                  redo();
                }}
              >
                <span>{t('editor.menu.redo', 'Redo')}</span>
                <span className="emb-shortcut">Ctrl+Y</span>
              </button>
            </>
          )}
          {items
            .filter(
              (item) =>
                item.kind !== 'command' || !item.optional || hasEditorCommand(item.id),
            )
            .map((item, i) =>
              item.kind === 'separator' ? (
                <div key={`sep-${i}`} className="emb-separator" />
              ) : item.kind === 'link' ? (
                renderLink(item)
              ) : (
                renderCommand(item)
              ),
            )}
        </div>
      )}
    </div>
  );

  return (
    <div className="editor-menubar" ref={rootRef}>
      {menu('file', t('editor.menu.file', 'File'), fileItems)}
      {menu('edit', t('editor.menu.edit', 'Edit'), editItems)}
      {menu('view', t('editor.menu.view', 'View'), viewItems)}
      {menu('language', t('editor.menu.language', 'Language'), [])}
      {menu('help', t('editor.menu.help', 'Help'), helpItems)}
    </div>
  );
};
