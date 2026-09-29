/**
 * Autosave the workspace to the local draft (utils/workspaceDraft) a second
 * after the last edit. Drives the Save button's status dot.
 *
 * `enabled` stays false until the editor has decided what to show (a
 * `?project=` load, the restored draft, or a starter), so the untouched
 * default canvas never overwrites a draft that has not been restored yet.
 */
import { useEffect, useState } from 'react';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useEditorStore } from '../store/useEditorStore';
import { saveDraft } from '../utils/workspaceDraft';

export type AutoSaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export interface AutoSaveState {
  status: AutoSaveStatus;
  lastSavedAt: number | null;
  errorMessage: string | null;
}

const DEBOUNCE_MS = 1000;

export function useWorkspaceDraft(enabled: boolean): AutoSaveState {
  const [state, setState] = useState<AutoSaveState>({
    status: 'idle',
    lastSavedAt: null,
    errorMessage: null,
  });

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      timer = null;
      setState((s) => ({ ...s, status: 'saving' }));
      saveDraft()
        .then((at) => setState({ status: 'saved', lastSavedAt: at, errorMessage: null }))
        .catch((err: unknown) =>
          setState((s) => ({
            ...s,
            status: 'error',
            errorMessage: err instanceof Error ? err.message : String(err),
          })),
        );
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, DEBOUNCE_MS);
      setState((s) => (s.status === 'dirty' ? s : { ...s, status: 'dirty' }));
    };

    // Structural edits only. A running board rewrites its own state many
    // times a second (serial, pin levels), so boards are compared only
    // while stopped; stopping fires one change, which saves once.
    const offSim = useSimulatorStore.subscribe((s, prev) => {
      if (s.components !== prev.components || s.wires !== prev.wires) schedule();
      else if (!s.running && s.boards !== prev.boards) schedule();
    });
    const offEditor = useEditorStore.subscribe((s, prev) => {
      if (s.fileGroups !== prev.fileGroups || s.folderGroups !== prev.folderGroups) schedule();
    });
    // What is on screen right now is the starting point worth keeping.
    flush();

    return () => {
      offSim();
      offEditor();
      if (timer) {
        clearTimeout(timer);
        flush();
      }
    };
  }, [enabled]);

  return state;
}
