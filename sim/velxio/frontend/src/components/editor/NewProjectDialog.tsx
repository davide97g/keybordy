/**
 * NewProjectDialog — starter-template picker.
 *
 * Shown (a) on a pristine `/editor` visit (over an emptied canvas), and
 * (b) from the "New workspace" button / File menu entry. Offers a blank
 * workspace plus a ready-to-run Blink starter per board family — Arduino,
 * ESP32 (one card per chip generation, XIAO variant preferred), Raspberry
 * Pi Pico — each card carrying the same circuit thumbnail the examples gallery
 * uses (/examples-thumbs/<id>.webp, CircuitPreview fallback).
 *
 * Selecting a board loads its gallery Blink example when one exists (full
 * wiring: 220Ω resistor + LED); boards without one get a fresh board whose
 * default sketch blinks the on-board LED.
 */
import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { BoardKind } from '../../types/board';
import { BOARD_KIND_LABELS } from '../../types/board';
import { useSimulatorStore, DEFAULT_BOARD_POSITION } from '../../store/useSimulatorStore';
import { useProjectStore } from '../../store/useProjectStore';
import { useEditorStore } from '../../store/useEditorStore';
import { getLocaleFromPath, localizedPath } from '../../i18n/path';
import { loadExample } from '../../utils/loadExample';
import type { ExampleProject } from '../../data/examples';
import { ExampleThumbnail } from '../examples/ExampleThumbnail';
import './NewProjectDialog.css';

interface NewProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Card blurbs (same voice as the component picker's board descriptions). */
const BOARD_BLURBS: Record<string, string> = {
  'arduino-uno': '8-bit AVR, 32KB flash, 14 digital I/O',
  'arduino-mega': '8-bit AVR, 256KB flash, 54 digital I/O',
  'arduino-nano': '8-bit AVR, 32KB flash, breadboard-size Uno',
  'arduino-nano-esp32': 'ESP32-S3 in the Nano footprint, WiFi+BT (QEMU)',
  esp32: 'Xtensa LX6 dual-core, WiFi+BT, 38 GPIO (QEMU)',
  'esp32-cam': 'ESP32 + OV2640 camera, streams to LCD (QEMU)',
  'xiao-esp32-s3': 'Seeed XIAO tiny form, 8MB flash+PSRAM (QEMU)',
  'xiao-esp32-c3': 'Seeed XIAO ESP32-C3 mini board (QEMU)',
  'raspberry-pi-pico': 'RP2040 dual-core Cortex-M0+',
};

/**
 * Starter-card thumbnail: reuse the gallery's convention-based thumbs
 * (/examples-thumbs/<id>.webp, CircuitPreview SVG fallback). Kinds with a
 * Blink example use that example's thumb; the rest use a captured
 * `starter-<kind>` shot living in the same folder.
 */
function thumbStubFor(kind: string, label: string): ExampleProject {
  return {
    id: PREFERRED_BLINK_EXAMPLE[kind] ?? `starter-${kind}`,
    title: label,
    description: '',
    category: 'basics',
    difficulty: 'beginner',
    boardType: kind,
    code: '',
    components: [],
    wires: [],
  };
}

/**
 * Empty the whole workspace: boards, components, wires, current project and
 * every editor file group. Removing the LAST board leaves the editor's
 * files/activeFileId mirror pointing at the deleted group (removeBoard only
 * re-points when another board remains), so Monaco kept showing the dead
 * sketch — pointing the editor at a nonexistent group blanks it.
 */
export function clearWorkspaceForStarter(): void {
  // currentProject FIRST — same auto-save hazard loadExample documents:
  // mutating the stores while a saved project is still "current" lets the
  // debounced PUT overwrite that project with the emptied content.
  useProjectStore.getState().clearCurrentProject();
  const sim = useSimulatorStore.getState();
  sim.boards.forEach((b) => sim.stopBoard(b.id));
  sim.boards.map((b) => b.id).forEach((id) => sim.removeBoard(id));
  sim.setComponents([]);
  sim.setWires([]);
  const editor = useEditorStore.getState();
  Object.keys(editor.fileGroups).forEach((g) => editor.deleteFileGroup(g));
  editor.setActiveGroup('');
}

/**
 * Gallery Blink example per board kind, when one exists. Preferred ids first
 * (some kinds have several blink-ish examples — e.g. esp32 also has the
 * ESP-IDF variant); a generic single-board "blink" search covers overlay
 * examples registered at runtime.
 */
const PREFERRED_BLINK_EXAMPLE: Record<string, string> = {
  'arduino-uno': 'blink-led',
  'arduino-mega': 'mega-blink',
  'arduino-nano': 'nano-blink',
  // Camera board: the webcam demo IS its "blink" — the board exists to
  // show the sensor, a bare LED sketch would be a misleading first run.
  'esp32-cam': 'esp32cam-webcam-demo',
  esp32: 'esp32-blink-led',
  'esp32-s3': 'esp32s3-blink-led',
  'esp32-c3': 'c3-blink',
  'esp32-c6': 'c6-blink',
  'raspberry-pi-pico': 'pico-blink',
};

/** Dynamic import keeps the (large) gallery data out of the editor bundle
 *  until a starter is actually picked. */
async function findBlinkExample(kind: string): Promise<ExampleProject | undefined> {
  const { exampleProjects } = await import('../../data/examples');
  const preferredId = PREFERRED_BLINK_EXAMPLE[kind];
  if (preferredId) {
    const preferred = exampleProjects.find((e) => e.id === preferredId);
    if (preferred) return preferred;
  }
  return exampleProjects.find(
    (e) => !e.boards && e.boardType === kind && /blink/i.test(`${e.id} ${e.title}`),
  );
}

/**
 * Replace the workspace with the chosen starter. 'blank' leaves an empty
 * canvas (boards are optional — the board-less analog examples rely on the
 * same state). Board kinds load their gallery Blink example when one exists;
 * otherwise a fresh board whose default sketch already blinks the on-board
 * LED (createFileGroup picks the per-board/language blink content).
 */
async function applyStarter(kind: string | 'blank'): Promise<void> {
  clearWorkspaceForStarter();

  if (kind !== 'blank') {
    let example: ExampleProject | undefined;
    try {
      example = await findBlinkExample(kind);
    } catch {
      example = undefined;
    }
    if (example) {
      await loadExample(example);
    } else {
      const fresh = useSimulatorStore.getState();
      const newId = fresh.addBoard(
        kind as BoardKind,
        DEFAULT_BOARD_POSITION.x,
        DEFAULT_BOARD_POSITION.y,
      );
      fresh.setActiveBoardId(newId);
    }
  }

  // The workspace no longer belongs to whatever project URL we were on —
  // leaving it would silently reload the OLD project over this fresh
  // workspace on refresh. replaceState, not pushState (a back-entry at the
  // stale project URL would remount the project route and reload it).
  const locale = getLocaleFromPath(window.location.pathname);
  const editorPath = localizedPath('/editor', locale);
  if (window.location.pathname !== editorPath) {
    window.history.replaceState(null, '', editorPath);
  }
}

export interface StarterSection {
  title: string;
  entries: Array<{ kind: string; blurb: string }>;
}

/** The card sections, in display order. */
export function buildStarterSections(): StarterSection[] {
  const oss = (k: BoardKind) => ({ kind: k as string, blurb: BOARD_BLURBS[k] ?? '' });
  return [
    {
      title: 'Arduino',
      entries: [
        oss('arduino-uno'),
        oss('arduino-mega'),
        oss('arduino-nano'),
        oss('arduino-nano-esp32'),
      ],
    },
    // One card per ESP32 chip generation, XIAO variant preferred where
    // Seeed makes one: classic → DevKit V1, S3/C3 → XIAO.
    {
      title: 'ESP32',
      entries: [oss('esp32'), oss('esp32-cam'), oss('xiao-esp32-s3'), oss('xiao-esp32-c3')],
    },
    { title: 'Raspberry Pi', entries: [oss('raspberry-pi-pico')] },
  ];
}

const SECTIONS = buildStarterSections();

export const NewProjectDialog: React.FC<NewProjectDialogProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSelect = (kind: string | 'blank') => {
    onClose();
    applyStarter(kind).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[editor] starter template failed to load:', err);
    });
  };

  // Portal to <body>: escape the canvas subtree so no ancestor stacking
  // context can pin the dialog below floating panels (e.g. the AI chat).
  return createPortal(
    <div className="new-project-overlay" onClick={onClose}>
      <div
        className="new-project-dialog"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="new-project-head">
          <h3 className="new-project-title">{t('editor.newProject.title')}</h3>
          <p className="new-project-sub">{t('editor.newProject.subtitle')}</p>
        </div>

        <div className="new-project-body">
          <div className="new-project-grid">
            <button
              className="new-project-card new-project-card-blank"
              onClick={() => handleSelect('blank')}
            >
              <span className="new-project-card-thumb new-project-card-thumb-blank">+</span>
              <span className="new-project-card-info">
                <span className="new-project-card-name">
                  {t('editor.newProject.blankTitle')}
                </span>
                <span className="new-project-card-desc">
                  {t('editor.newProject.blankDesc')}
                </span>
              </span>
            </button>
          </div>

          {SECTIONS.map((section) =>
            section.entries.length === 0 ? null : (
              <React.Fragment key={section.title}>
                <div className="new-project-section-title">{section.title}</div>
                <div className="new-project-grid">
                  {section.entries.map(({ kind, blurb }) => {
                    const label = BOARD_KIND_LABELS[kind as BoardKind] ?? kind;
                    return (
                      <button
                        key={kind}
                        className="new-project-card"
                        onClick={() => handleSelect(kind)}
                      >
                        <span className="new-project-card-thumb">
                          <ExampleThumbnail
                            example={thumbStubFor(kind, label)}
                            width={300}
                            height={180}
                          />
                        </span>
                        <span className="new-project-card-info">
                          <span className="new-project-card-name">{label}</span>
                          <span className="new-project-card-desc">{blurb}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </React.Fragment>
            ),
          )}
        </div>

        <div className="new-project-foot">
          <button className="new-project-cancel" onClick={onClose}>
            {t('editor.newProject.cancel')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
