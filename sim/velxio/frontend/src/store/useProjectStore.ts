import { create } from 'zustand';

interface CurrentProject {
  /** Stable id of the loaded project (the repo folder name for a
   *  `?project=` load). Sent with compiles as `project_id`. */
  id: string;
  /** Download filename stem for Save / Export. */
  slug: string;
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
  setCurrentExampleId: (id) => set({ currentExampleId: id }),
}));
