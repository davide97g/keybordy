/**
 * Autosave the workspace a second after the last edit: to the local draft,
 * or to the server for a saved project (utils/workspacePersistence). Drives
 * the Save button's status dot. A saved project the server could not take
 * shows as an error ("kept in this browser") and is retried.
 *
 * `enabled` stays false until the editor has decided what to show (a
 * `?project=` load, the restored draft, or a starter), so the untouched
 * default canvas never overwrites a draft that has not been restored yet.
 */
import { useEffect, useState } from 'react';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useEditorStore } from '../store/useEditorStore';
import { persistWorkspace } from '../utils/workspacePersistence';

export type AutoSaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export interface AutoSaveState {
  status: AutoSaveStatus;
  lastSavedAt: number | null;
  errorMessage: string | null;
}

const DEBOUNCE_MS = 1000;
const RETRY_MS = 10_000;

export function useWorkspaceDraft(enabled: boolean): AutoSaveState {
  const [state, setState] = useState<AutoSaveState>({
    status: 'idle',
    lastSavedAt: null,
    errorMessage: null,
  });

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    // One save at a time; edits that land meanwhile trigger one more.
    let inFlight = false;
    let again = false;
    let disposed = false;

    const flush = () => {
      timer = null;
      if (retry) {
        clearTimeout(retry);
        retry = null;
      }
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      setState((s) => ({ ...s, status: 'saving' }));
      persistWorkspace()
        .then((outcome) => {
          if (outcome.kind === 'saved') {
            setState({ status: 'saved', lastSavedAt: outcome.at, errorMessage: null });
            return;
          }
          setState((s) => ({
            status: 'error',
            lastSavedAt: outcome.kind === 'offline' ? outcome.at : s.lastSavedAt,
            errorMessage: outcome.message,
          }));
          if (outcome.kind === 'offline' && !disposed) retry = setTimeout(flush, RETRY_MS);
        })
        .catch((err: unknown) =>
          setState((s) => ({
            ...s,
            status: 'error',
            errorMessage: err instanceof Error ? err.message : String(err),
          })),
        )
        .finally(() => {
          inFlight = false;
          if (again && !disposed) {
            again = false;
            flush();
          }
        });
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
    const onOnline = () => {
      if (retry) flush();
    };
    window.addEventListener('online', onOnline);
    // What is on screen right now is the starting point worth keeping.
    flush();

    return () => {
      disposed = true;
      offSim();
      offEditor();
      window.removeEventListener('online', onOnline);
      if (retry) clearTimeout(retry);
      if (timer) {
        clearTimeout(timer);
        flush();
      }
    };
  }, [enabled]);

  return state;
}
