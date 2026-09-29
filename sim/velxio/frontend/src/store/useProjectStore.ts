import { create } from 'zustand';

export interface CurrentProject {
  /** Stable id of the loaded project: the repo folder name for a
   *  `?project=` load, the database id for a saved project. Sent with
   *  compiles as `project_id` (the backend ignores it). */
  id: string;
  /** Download filename stem for Save / Export. */
  slug: string;
  /** Where the workspace lives. 'saved' autosaves to /api/projects; the
   *  rest (a firmware/ folder, scratch) autosave to the browser draft.
   *  Absent in drafts written before saved projects existed. */
  source?: 'folder' | 'saved';
  /** Saved projects: display name and the server revision this tab
   *  last loaded or wrote (optimistic concurrency base). */
  name?: string;
  revision?: number;
}

interface ProjectState {
  currentProject: CurrentProject | null;
  /**
   * Gallery example currently loaded in the editor (null when the workspace
   * came from a project, a file or scratch).
   */
  currentExampleId: string | null;
  setCurrentProject: (project: CurrentProject) => void;
  clearCurrentProject: () => void;
  /** Update a saved project's revision, only while it is still the one open. */
  setRevision: (id: string, revision: number) => void;
  setCurrentExampleId: (id: string | null) => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  currentProject: null,
  currentExampleId: null,
  // Loading a real project supersedes the example context.
  setCurrentProject: (project) => set({ currentProject: project, currentExampleId: null }),
  // Also drops the example context: every caller (new project, blank
  // workspace) means "this workspace is no longer that".
  // loadExample re-stamps its id right after calling this.
  clearCurrentProject: () => set({ currentProject: null, currentExampleId: null }),
  setRevision: (id, revision) =>
    set((s) =>
      s.currentProject?.id === id ? { currentProject: { ...s.currentProject, revision } } : s,
    ),
  setCurrentExampleId: (id) => set({ currentExampleId: id }),
}));
