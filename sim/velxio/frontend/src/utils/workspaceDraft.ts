/**
 * Workspace draft — the editor's local autosave.
 *
 * The whole workspace (the lossless `.vlx` snapshot) plus the loaded
 * project's name is kept in IndexedDB, so a reload of `/editor` comes back
 * to the circuit and code that were on screen. Nothing leaves the browser.
 * IndexedDB rather than localStorage because a snapshot can carry chip
 * wasm and SD card files, well past localStorage's few megabytes.
 */
import { del as idbDel, get as idbGet, set as idbSet } from 'idb-keyval';
import { useProjectStore } from '../store/useProjectStore';
import { flushChipFileSync } from '../services/chipFiles';
import { buildVlxPayload, importVlxFile } from './vlxFile';

const DRAFT_KEY = 'velxio-workspace-draft';

interface StoredDraft {
  /** The `.vlx` payload, as JSON text. */
  vlx: string;
  project: { id: string; slug: string } | null;
  savedAt: number;
}

/** Snapshot the workspace into the draft slot. Resolves with the save time. */
export async function saveDraft(): Promise<number> {
  flushChipFileSync();
  const draft: StoredDraft = {
    vlx: JSON.stringify(buildVlxPayload()),
    project: useProjectStore.getState().currentProject,
    savedAt: Date.now(),
  };
  await idbSet(DRAFT_KEY, draft);
  return draft.savedAt;
}

/** Load the draft into the stores. Resolves false when there is none. */
export async function restoreDraft(): Promise<boolean> {
  let draft: StoredDraft | undefined;
  try {
    draft = await idbGet<StoredDraft>(DRAFT_KEY);
  } catch {
    return false; // storage blocked (private window): start clean
  }
  if (!draft?.vlx) return false;
  try {
    await importVlxFile(new File([draft.vlx], 'draft.vlx', { type: 'application/json' }));
  } catch (err) {
    console.warn('[draft] discarding an unreadable draft:', err);
    await clearDraft();
    return false;
  }
  if (draft.project) useProjectStore.getState().setCurrentProject(draft.project);
  return true;
}

export async function clearDraft(): Promise<void> {
  try {
    await idbDel(DRAFT_KEY);
  } catch {
    /* storage blocked: nothing to clear */
  }
}
