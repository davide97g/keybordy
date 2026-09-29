/**
 * services/projectsApi: snake_case wire format in, camelCase out, and the
 * error mapping the autosave relies on to tell "keep it locally" apart from
 * "someone saved first".
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  NameTakenError,
  ProjectNotFoundError,
  ProjectsUnavailableError,
  RevisionConflictError,
  listProjects,
  renameProject,
  saveProject,
} from '../services/projectsApi';
import type { VlxPayload } from '../utils/vlxFile';

const payload = { format: 'velxio-project', boards: [], fileGroups: {} } as unknown as VlxPayload;

function respond(status: number, body: string, type = 'application/json') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status, headers: { 'Content-Type': type } })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('projectsApi', () => {
  it('maps list summaries to camelCase', async () => {
    respond(
      200,
      JSON.stringify([
        {
          id: 'a',
          name: 'keys8',
          source_folder: 'keys8',
          revision: 2,
          board_kinds: ['esp32'],
          created_at: 'c',
          updated_at: 'u',
        },
      ]),
    );
    expect(await listProjects()).toEqual([
      {
        id: 'a',
        name: 'keys8',
        sourceFolder: 'keys8',
        revision: 2,
        boardKinds: ['esp32'],
        createdAt: 'c',
        updatedAt: 'u',
      },
    ]);
  });

  it('treats network errors, proxy error pages and 503 as unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
    );
    await expect(listProjects()).rejects.toBeInstanceOf(ProjectsUnavailableError);
    respond(502, '<html>Bad Gateway</html>', 'text/html');
    await expect(listProjects()).rejects.toBeInstanceOf(ProjectsUnavailableError);
    respond(503, JSON.stringify({ detail: { code: 'database_unavailable' } }));
    await expect(listProjects()).rejects.toBeInstanceOf(ProjectsUnavailableError);
  });

  it('maps 409s and 404', async () => {
    respond(409, JSON.stringify({ detail: { code: 'revision_conflict', current_revision: 9 } }));
    const err = await saveProject('a', payload, 1).catch((e) => e);
    expect(err).toBeInstanceOf(RevisionConflictError);
    expect(err.currentRevision).toBe(9);

    respond(409, JSON.stringify({ detail: { code: 'name_taken' } }));
    await expect(renameProject('a', 'x')).rejects.toBeInstanceOf(NameTakenError);

    respond(404, JSON.stringify({ detail: { code: 'not_found' } }));
    await expect(renameProject('a', 'x')).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});
