/**
 * Client for the backend project store (/api/projects, Postgres).
 *
 * The wire format is snake_case like the rest of the API; the payload is the
 * `.vlx` object (utils/vlxFile) stored as-is. Failures come back as typed
 * errors so callers can tell "server down, keep it in the browser" from
 * "someone else saved first".
 */
import { getApiBase } from '../lib/apiBase';
import type { VlxPayload } from '../utils/vlxFile';

export interface ProjectSummary {
  id: string;
  name: string;
  sourceFolder: string | null;
  revision: number;
  boardKinds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDetail extends ProjectSummary {
  payload: VlxPayload;
}

export interface SaveResult {
  id: string;
  revision: number;
  updatedAt: string;
}

/** Network error, proxy error or 503: the database or backend is not there. */
export class ProjectsUnavailableError extends Error {
  constructor(message = 'Project store unreachable') {
    super(message);
    this.name = 'ProjectsUnavailableError';
  }
}

export class ProjectNotFoundError extends Error {
  constructor() {
    super('Project not found');
    this.name = 'ProjectNotFoundError';
  }
}

export class NameTakenError extends Error {
  constructor() {
    super('A project with that name already exists');
    this.name = 'NameTakenError';
  }
}

/** The project moved past the revision this tab based its save on. */
export class RevisionConflictError extends Error {
  readonly currentRevision: number;
  constructor(currentRevision: number) {
    super('Project changed in another tab or window');
    this.name = 'RevisionConflictError';
    this.currentRevision = currentRevision;
  }
}

interface WireSummary {
  id: string;
  name: string;
  source_folder: string | null;
  revision: number;
  board_kinds: string[];
  created_at: string;
  updated_at: string;
}

function summary(w: WireSummary): ProjectSummary {
  return {
    id: w.id,
    name: w.name,
    sourceFolder: w.source_folder,
    revision: w.revision,
    boardKinds: w.board_kinds,
    createdAt: w.created_at,
    updatedAt: w.updated_at,
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${getApiBase()}/projects${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch (err) {
    throw new ProjectsUnavailableError(err instanceof Error ? err.message : undefined);
  }
  if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;

  let detail: { code?: string; current_revision?: number } | undefined;
  try {
    detail = (await res.json())?.detail;
  } catch {
    /* nginx / Vite proxy error pages are not JSON */
  }
  if (res.status === 404) throw new ProjectNotFoundError();
  if (res.status === 409 && detail?.code === 'revision_conflict') {
    throw new RevisionConflictError(detail.current_revision ?? 0);
  }
  if (res.status === 409 && detail?.code === 'name_taken') throw new NameTakenError();
  if (res.status >= 500) throw new ProjectsUnavailableError(`Project store answered ${res.status}`);
  throw new Error(`Project store rejected the request (${res.status})`);
}

export async function listProjects(): Promise<ProjectSummary[]> {
  return (await request<WireSummary[]>('')).map(summary);
}

export async function getProject(id: string): Promise<ProjectDetail> {
  const w = await request<WireSummary & { payload: VlxPayload }>(`/${encodeURIComponent(id)}`);
  return { ...summary(w), payload: w.payload };
}

export async function createProject(input: {
  name: string;
  payload: VlxPayload;
  sourceFolder?: string | null;
}): Promise<ProjectDetail> {
  const w = await request<WireSummary & { payload: VlxPayload }>('', {
    method: 'POST',
    body: JSON.stringify({
      name: input.name,
      payload: input.payload,
      source_folder: input.sourceFolder ?? null,
    }),
  });
  return { ...summary(w), payload: w.payload };
}

export async function saveProject(
  id: string,
  payload: VlxPayload,
  baseRevision: number,
): Promise<SaveResult> {
  const w = await request<{ id: string; revision: number; updated_at: string }>(
    `/${encodeURIComponent(id)}`,
    { method: 'PUT', body: JSON.stringify({ payload, base_revision: baseRevision }) },
  );
  return { id: w.id, revision: w.revision, updatedAt: w.updated_at };
}

export async function renameProject(id: string, name: string): Promise<ProjectSummary> {
  return summary(
    await request<WireSummary>(`/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  );
}

export async function deleteProject(id: string): Promise<void> {
  await request<void>(`/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
