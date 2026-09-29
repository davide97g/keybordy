/**
 * Where the workspace autosaves, and how it comes back.
 *
 * - Scratch and firmware/ folder workspaces go to the browser draft
 *   (utils/workspaceDraft), as before. A `?project=` folder is re-read from
 *   the repo on every load, so it is never written to the database on its
 *   own: "Save to projects" forks it into a saved project.
 * - Saved projects (currentProject.source === 'saved') autosave to
 *   /api/projects with optimistic concurrency. Every save first writes a
 *   local copy to IndexedDB marked dirty and clears the flag once the server
 *   has it, so a save made while the server is down is pushed on the next
 *   open, and the project still opens offline.
 */
import { del as idbDel, get as idbGet, set as idbSet } from 'idb-keyval';
import { useProjectStore, type CurrentProject } from '../store/useProjectStore';
import { useProjectSyncStore } from '../store/useProjectSyncStore';
import { flushChipFileSync } from '../services/chipFiles';
import {
  ProjectNotFoundError,
  RevisionConflictError,
  createProject,
  getProject,
  saveProject,
} from '../services/projectsApi';
import { buildVlxPayload, importVlxFile, type VlxPayload } from './vlxFile';
import { restoreDraft, saveDraft } from './workspaceDraft';

const LOCAL_COPY_PREFIX = 'velxio-saved-copy:';
const LAST_OPEN_KEY = 'velxio-last-open';

interface LocalCopy {
  /** The `.vlx` payload, as JSON text. */
  vlx: string;
  name: string;
  /** Server revision the copy is based on. */
  baseRevision: number;
  /** True until the server has accepted this content. */
  dirty: boolean;
  savedAt: number;
}

type LastOpen = { kind: 'saved'; id: string } | { kind: 'draft' };

export type PersistOutcome =
  | { kind: 'saved'; at: number }
  /** Saved project kept in the browser only; retry later. */
  | { kind: 'offline'; at: number; message: string }
  | { kind: 'conflict'; message: string };

// Storage can be blocked (private window); persistence then degrades to the
// server alone instead of failing the save.
async function idbTry<T>(op: () => Promise<T>): Promise<T | undefined> {
  try {
    return await op();
  } catch {
    return undefined;
  }
}

const readLocalCopy = (id: string) => idbTry(() => idbGet<LocalCopy>(LOCAL_COPY_PREFIX + id));
const writeLocalCopy = (id: string, copy: LocalCopy) =>
  idbTry(() => idbSet(LOCAL_COPY_PREFIX + id, copy));
export const dropLocalCopy = (id: string) => idbTry(() => idbDel(LOCAL_COPY_PREFIX + id));
const writeLastOpen = (last: LastOpen) => idbTry(() => idbSet(LAST_OPEN_KEY, last));

/** The workspace content as compared between saves: exportedAt changes on
 *  every call and the name is renamed through PATCH, not autosave. */
function comparable(payload: VlxPayload): string {
  return JSON.stringify({ ...payload, exportedAt: '', name: undefined });
}

// Last content the server confirmed for the open project: skips the PUT
// right after a load and when a store change left the content as it was.
let synced: { id: string; content: string } | null = null;

function markSynced(id: string): void {
  synced = { id, content: comparable(buildVlxPayload()) };
}

function slugOf(name: string): string {
  return (
    name
      .trim()
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  );
}

function savedProject(id: string, name: string, revision: number): CurrentProject {
  return { id, slug: slugOf(name), source: 'saved', name, revision };
}

/** Autosave the workspace wherever it lives. */
export async function persistWorkspace(): Promise<PersistOutcome> {
  flushChipFileSync();
  const project = useProjectStore.getState().currentProject;
  if (project?.source !== 'saved') {
    const at = await saveDraft();
    await writeLastOpen({ kind: 'draft' });
    return { kind: 'saved', at };
  }

  const { id } = project;
  const baseRevision = project.revision ?? 1;
  const name = project.name ?? project.slug;
  const payload = buildVlxPayload({ name });
  const content = comparable(payload);
  const at = Date.now();
  await writeLastOpen({ kind: 'saved', id });
  if (synced?.id === id && synced.content === content) return { kind: 'saved', at };

  await writeLocalCopy(id, {
    vlx: JSON.stringify(payload),
    name,
    baseRevision,
    dirty: true,
    savedAt: at,
  });
  // Don't hammer the server while the user decides how to resolve a conflict.
  if (useProjectSyncStore.getState().conflict?.projectId === id) {
    return { kind: 'conflict', message: 'Changed in another tab or window' };
  }
  try {
    const result = await saveProject(id, payload, baseRevision);
    useProjectStore.getState().setRevision(id, result.revision);
    synced = { id, content };
    await writeLocalCopy(id, {
      vlx: JSON.stringify(payload),
      name,
      baseRevision: result.revision,
      dirty: false,
      savedAt: at,
    });
    return { kind: 'saved', at };
  } catch (err) {
    if (err instanceof RevisionConflictError) {
      useProjectSyncStore
        .getState()
        .setConflict({ projectId: id, serverRevision: err.currentRevision });
      return { kind: 'conflict', message: err.message };
    }
    if (err instanceof ProjectNotFoundError) {
      // Deleted elsewhere: keep the work as the browser draft.
      await detachSavedProject();
      return { kind: 'offline', at, message: 'Project was deleted; kept as a browser draft' };
    }
    return { kind: 'offline', at, message: 'Server unreachable, kept in this browser' };
  }
}

async function loadPayload(vlx: string | VlxPayload, project: CurrentProject): Promise<void> {
  const text = typeof vlx === 'string' ? vlx : JSON.stringify(vlx);
  await importVlxFile(new File([text], `${project.slug}.vlx`, { type: 'application/json' }));
  useProjectStore.getState().setCurrentProject(project);
}

export type OpenResult = 'opened' | 'offline-copy' | 'not-found' | 'unavailable';

/**
 * Open a saved project. A dirty local copy based on the current server
 * revision (edits made while the server was down) wins and is pushed by the
 * next autosave; one based on an older revision is shown and flagged as a
 * conflict for the user to resolve.
 */
export async function openSavedProject(id: string): Promise<OpenResult> {
  const local = await readLocalCopy(id);
  let detail;
  try {
    detail = await getProject(id);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      await dropLocalCopy(id);
      return 'not-found';
    }
    if (!local) return 'unavailable';
    await loadPayload(local.vlx, savedProject(id, local.name, local.baseRevision));
    await writeLastOpen({ kind: 'saved', id });
    return 'offline-copy';
  }

  useProjectSyncStore.getState().setConflict(null);
  if (local?.dirty && local.baseRevision === detail.revision) {
    await loadPayload(local.vlx, savedProject(id, detail.name, detail.revision));
    synced = null; // push it
  } else if (local?.dirty && local.baseRevision < detail.revision) {
    await loadPayload(local.vlx, savedProject(id, detail.name, local.baseRevision));
    synced = null;
    useProjectSyncStore.getState().setConflict({ projectId: id, serverRevision: detail.revision });
  } else {
    await loadPayload(detail.payload, savedProject(id, detail.name, detail.revision));
    markSynced(id);
    await writeLocalCopy(id, {
      vlx: JSON.stringify(detail.payload),
      name: detail.name,
      baseRevision: detail.revision,
      dirty: false,
      savedAt: Date.now(),
    });
  }
  await writeLastOpen({ kind: 'saved', id });
  return 'opened';
}

/** Plain `/editor`: reopen the saved project that was open last, else the draft. */
export async function restoreWorkspace(): Promise<boolean> {
  const last = await idbTry(() => idbGet<LastOpen>(LAST_OPEN_KEY));
  if (last?.kind === 'saved') {
    const result = await openSavedProject(last.id);
    if (result === 'opened' || result === 'offline-copy') return true;
  }
  return restoreDraft();
}

/** Fork the workspace into a new saved project and switch to it. */
export async function saveCurrentAsProject(name: string): Promise<CurrentProject> {
  flushChipFileSync();
  const current = useProjectStore.getState().currentProject;
  const sourceFolder = current?.source === 'folder' ? current.id : null;
  const detail = await createProject({ name, payload: buildVlxPayload({ name }), sourceFolder });
  const previousId = current?.source === 'saved' ? current.id : null;
  const project = savedProject(detail.id, detail.name, detail.revision);
  useProjectStore.getState().setCurrentProject(project);
  useProjectSyncStore.getState().setConflict(null);
  markSynced(detail.id);
  await writeLocalCopy(detail.id, {
    vlx: JSON.stringify(detail.payload),
    name: detail.name,
    baseRevision: detail.revision,
    dirty: false,
    savedAt: Date.now(),
  });
  // Saving a conflicted project as a copy leaves nothing unsynced behind.
  if (previousId) await dropLocalCopy(previousId);
  await writeLastOpen({ kind: 'saved', id: detail.id });
  return project;
}

/** Conflict: replace the screen with the server's copy. */
export async function loadLatest(id: string): Promise<void> {
  await dropLocalCopy(id);
  useProjectSyncStore.getState().setConflict(null);
  await openSavedProject(id);
}

/** Conflict: write this tab's copy over the server's. */
export async function overwriteWithCurrent(
  id: string,
  serverRevision: number,
): Promise<PersistOutcome> {
  useProjectStore.getState().setRevision(id, serverRevision);
  useProjectSyncStore.getState().setConflict(null);
  synced = null;
  return persistWorkspace();
}

/** The open saved project is gone (deleted): keep the workspace as the draft. */
export async function detachSavedProject(): Promise<void> {
  const current = useProjectStore.getState().currentProject;
  if (current?.source !== 'saved') return;
  await dropLocalCopy(current.id);
  useProjectSyncStore.getState().setConflict(null);
  useProjectStore.getState().setCurrentProject({ id: current.slug, slug: current.slug });
  synced = null;
  await saveDraft();
  await writeLastOpen({ kind: 'draft' });
}

/** Keep `?id=<uuid>` in the address bar in step with the open saved project. */
export function syncSavedProjectUrl(project: CurrentProject | null): void {
  const url = new URL(window.location.href);
  const want = project?.source === 'saved' ? project.id : null;
  if (url.searchParams.get('id') === want) return;
  if (want) {
    url.searchParams.set('id', want);
    url.searchParams.delete('project');
  } else if (url.searchParams.has('id')) {
    url.searchParams.delete('id');
  } else {
    return;
  }
  window.history.replaceState(window.history.state, '', url);
}

export function savedProjectParam(): string | null {
  return new URLSearchParams(window.location.search).get('id');
}
