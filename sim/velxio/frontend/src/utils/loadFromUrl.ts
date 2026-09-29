/**
 * Load a project served next to the app: `/editor?project=<name>`.
 *
 * `<name>` is a folder under `/projects/` (nginx serves the host's project
 * folders there, with a JSON directory listing). A folder holds a Wokwi
 * project — diagram.json plus the sketch sources — and is imported the same
 * way a Wokwi .zip is. `<name>` may also name a `.vlx` or `.zip` file under
 * `/projects/`. Every load re-reads the files, so the folder on disk stays
 * the source of truth: edit it, reload the page.
 */
import { importFromWokwiSources, type WokwiSourceFile } from './wokwiZip';
import { applyWokwiImport, importProjectFile } from './importProject';
import { ensureLibraries } from './loadExample';
import { useProjectStore } from '../store/useProjectStore';

const PROJECTS_BASE = '/projects/';

/** Files a folder project may contribute: the diagram, sources, metadata. */
const WANTED = /(^diagram\.json$|^libraries\.txt$|\.(ino|h|hpp|c|cc|cpp|cxx|py|s)$|\.chip\.json$)/i;

interface ListingEntry {
  name: string;
  type: 'file' | 'directory' | string;
}

/** The `?project=` value of the current URL, or null. */
export function projectParam(): string | null {
  const v = new URLSearchParams(window.location.search).get('project');
  return v && v.trim() ? v.trim().replace(/^\/+|\/+$/g, '') : null;
}

// nginx answers any missing path with the SPA's index.html (200, text/html),
// so "ok" alone does not mean the file exists.
async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url, { cache: 'no-store' });
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || type.includes('text/html')) throw new Error(`Not found: ${url}`);
  return res;
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

async function readFolder(name: string): Promise<WokwiSourceFile[]> {
  const base = `${PROJECTS_BASE}${encodePath(name)}/`;
  const listing = (await (await fetchOk(base)).json()) as ListingEntry[];
  const names = listing.filter((e) => e.type === 'file' && WANTED.test(e.name)).map((e) => e.name);
  if (!names.includes('diagram.json')) throw new Error(`No diagram.json in ${base}`);
  return Promise.all(
    names.map(async (n) => ({
      name: n,
      content: await (await fetchOk(base + encodeURIComponent(n))).text(),
    })),
  );
}

/**
 * Load `name` into the stores. Resolves with the import warnings; rejects
 * when the project cannot be read.
 */
export async function loadProjectFromUrl(name: string): Promise<string[]> {
  if (/\.(vlx|zip)$/i.test(name)) {
    const blob = await (await fetchOk(PROJECTS_BASE + encodePath(name))).blob();
    const file = new File([blob], name.split('/').pop() ?? name);
    const result = await importProjectFile(file);
    const warnings = result.kind === 'zip' ? applyWokwiImport(result) : [];
    if (result.kind === 'zip' && result.libraries.length > 0) await ensureLibraries(result.libraries);
    useProjectStore.getState().setCurrentProject({
      id: name,
      slug: file.name.replace(/\.\w+$/, ''),
      source: 'folder',
    });
    return warnings;
  }
  const result = importFromWokwiSources(await readFolder(name));
  const warnings = applyWokwiImport(result);
  if (result.libraries.length > 0) await ensureLibraries(result.libraries);
  useProjectStore.getState().setCurrentProject({ id: name, slug: name.split('/').pop() ?? name, source: 'folder' });
  return warnings;
}
