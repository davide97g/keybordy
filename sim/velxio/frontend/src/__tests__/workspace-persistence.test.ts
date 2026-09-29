// @vitest-environment jsdom
/**
 * Autosave routing (utils/workspacePersistence): folder/scratch workspaces
 * stay in the browser draft; saved projects PUT to /api/projects with
 * optimistic concurrency, keep a dirty local copy while the server can't
 * take them, and flag conflicts instead of overwriting.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const idb = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: vi.fn(async (k: string) => idb.get(k)),
  set: vi.fn(async (k: string, v: unknown) => void idb.set(k, v)),
  del: vi.fn(async (k: string) => void idb.delete(k)),
}));

import { useEditorStore } from '../store/useEditorStore';
import { useProjectStore } from '../store/useProjectStore';
import { useProjectSyncStore } from '../store/useProjectSyncStore';
import { buildVlxPayload } from '../utils/vlxFile';
import {
  openSavedProject,
  persistWorkspace,
  saveCurrentAsProject,
  syncSavedProjectUrl,
} from '../utils/workspacePersistence';

const ID = '11111111-2222-3333-4444-555555555555';
const COPY_KEY = `velxio-saved-copy:${ID}`;

interface Call {
  method: string;
  url: string;
  body?: { base_revision?: number; name?: string };
}
let calls: Call[] = [];

function json(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(handler: (call: Call) => Response | Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      return handler(call);
    }),
  );
}

function serverProject(revision: number, payload = buildVlxPayload({ name: 'keys8 copy' })) {
  return {
    id: ID,
    name: 'keys8 copy',
    source_folder: 'keys8',
    revision,
    board_kinds: [],
    created_at: '2026-09-29T00:00:00Z',
    updated_at: '2026-09-29T00:00:00Z',
    payload,
  };
}

function editSketch(content: string) {
  const store = useEditorStore.getState();
  const gid = Object.keys(store.fileGroups)[0];
  useEditorStore.setState({
    fileGroups: {
      ...store.fileGroups,
      [gid]: [{ id: 'f1', name: 'sketch.ino', content, modified: true }],
    },
  } as never);
}

function openAsSaved(revision: number) {
  useProjectStore.getState().setCurrentProject({
    id: ID,
    slug: 'keys8-copy',
    source: 'saved',
    name: 'keys8 copy',
    revision,
  });
}

beforeEach(() => {
  idb.clear();
  calls = [];
  vi.unstubAllGlobals();
  useProjectStore.getState().clearCurrentProject();
  useProjectSyncStore.getState().setConflict(null);
  window.history.replaceState(null, '', '/editor');
});

describe('persistWorkspace', () => {
  it('keeps folder workspaces in the browser draft and never calls the API', async () => {
    mockFetch(() => json(500, {}));
    useProjectStore.getState().setCurrentProject({ id: 'keys8', slug: 'keys8', source: 'folder' });
    const outcome = await persistWorkspace();
    expect(outcome.kind).toBe('saved');
    expect(calls).toHaveLength(0);
    expect(idb.has('velxio-workspace-draft')).toBe(true);
  });

  it('PUTs a saved project on its revision and records the new one', async () => {
    mockFetch(() => json(200, { id: ID, revision: 4, updated_at: '2026-09-29T00:00:01Z' }));
    openAsSaved(3);
    editSketch('void setup() { /* a */ }');
    const outcome = await persistWorkspace();
    expect(outcome.kind).toBe('saved');
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].body?.base_revision).toBe(3);
    expect(useProjectStore.getState().currentProject?.revision).toBe(4);
    expect((idb.get(COPY_KEY) as { dirty: boolean }).dirty).toBe(false);

    // Nothing changed since: no second PUT.
    await persistWorkspace();
    expect(calls).toHaveLength(1);
  });

  it('keeps a dirty local copy when the server is unreachable', async () => {
    mockFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    openAsSaved(2);
    editSketch('void setup() { /* offline */ }');
    const outcome = await persistWorkspace();
    expect(outcome.kind).toBe('offline');
    const copy = idb.get(COPY_KEY) as { dirty: boolean; baseRevision: number; vlx: string };
    expect(copy.dirty).toBe(true);
    expect(copy.baseRevision).toBe(2);
    expect(copy.vlx).toContain('offline');
  });

  it('flags a conflict on 409 and stops PUTting until it is resolved', async () => {
    mockFetch(() => json(409, { detail: { code: 'revision_conflict', current_revision: 7 } }));
    openAsSaved(5);
    editSketch('void setup() { /* mine */ }');
    expect((await persistWorkspace()).kind).toBe('conflict');
    expect(useProjectSyncStore.getState().conflict).toEqual({ projectId: ID, serverRevision: 7 });

    editSketch('void setup() { /* mine, more */ }');
    expect((await persistWorkspace()).kind).toBe('conflict');
    expect(calls).toHaveLength(1);
  });
});

describe('openSavedProject', () => {
  it('loads the server copy and does not PUT it straight back', async () => {
    editSketch('void setup() { /* server */ }');
    const payload = buildVlxPayload({ name: 'keys8 copy' });
    mockFetch((call) =>
      call.method === 'GET' ? json(200, serverProject(3, payload)) : json(500, {}),
    );
    expect(await openSavedProject(ID)).toBe('opened');
    expect(useProjectStore.getState().currentProject).toMatchObject({
      id: ID,
      source: 'saved',
      revision: 3,
    });
    await persistWorkspace();
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('pushes a dirty copy based on the current server revision', async () => {
    editSketch('void setup() { /* offline edit */ }');
    idb.set(COPY_KEY, {
      vlx: JSON.stringify(buildVlxPayload({ name: 'keys8 copy' })),
      name: 'keys8 copy',
      baseRevision: 3,
      dirty: true,
      savedAt: 1,
    });
    editSketch('void setup() { /* server */ }');
    mockFetch((call) =>
      call.method === 'GET'
        ? json(200, serverProject(3))
        : json(200, { id: ID, revision: 4, updated_at: '2026-09-29T00:00:01Z' }),
    );
    await openSavedProject(ID);
    const group = Object.values(useEditorStore.getState().fileGroups)[0];
    expect(group[0].content).toContain('offline edit');
    await persistWorkspace();
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect(calls[1].body?.base_revision).toBe(3);
  });

  it('flags a conflict for a dirty copy based on an older revision', async () => {
    idb.set(COPY_KEY, {
      vlx: JSON.stringify(buildVlxPayload({ name: 'keys8 copy' })),
      name: 'keys8 copy',
      baseRevision: 2,
      dirty: true,
      savedAt: 1,
    });
    mockFetch(() => json(200, serverProject(5)));
    await openSavedProject(ID);
    expect(useProjectSyncStore.getState().conflict).toEqual({ projectId: ID, serverRevision: 5 });
  });

  it('opens the local copy when the server is down', async () => {
    idb.set(COPY_KEY, {
      vlx: JSON.stringify(buildVlxPayload({ name: 'keys8 copy' })),
      name: 'keys8 copy',
      baseRevision: 2,
      dirty: false,
      savedAt: 1,
    });
    mockFetch(() => json(503, { detail: { code: 'database_unavailable' } }));
    expect(await openSavedProject(ID)).toBe('offline-copy');
    expect(useProjectStore.getState().currentProject?.id).toBe(ID);
  });

  it('reports a deleted project', async () => {
    mockFetch(() => json(404, { detail: { code: 'not_found' } }));
    expect(await openSavedProject(ID)).toBe('not-found');
  });
});

describe('saveCurrentAsProject', () => {
  it('forks a folder workspace, recording where it came from', async () => {
    useProjectStore.getState().setCurrentProject({ id: 'keys8', slug: 'keys8', source: 'folder' });
    mockFetch(() => json(201, serverProject(1)));
    const project = await saveCurrentAsProject('keys8 copy');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toMatchObject({ name: 'keys8 copy', source_folder: 'keys8' });
    expect(project).toMatchObject({ id: ID, source: 'saved', revision: 1 });
  });
});

describe('syncSavedProjectUrl', () => {
  it('puts ?id= in the URL for a saved project and drops ?project=', () => {
    window.history.replaceState(null, '', '/editor?project=keys8');
    syncSavedProjectUrl({ id: ID, slug: 'x', source: 'saved' });
    expect(window.location.search).toBe(`?id=${ID}`);
    syncSavedProjectUrl(null);
    expect(window.location.search).toBe('');
  });
});
