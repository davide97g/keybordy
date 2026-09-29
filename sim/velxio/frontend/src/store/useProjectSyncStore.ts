import { create } from 'zustand';

/** A saved project whose server copy moved past what this tab has on screen. */
export interface ProjectConflict {
  projectId: string;
  serverRevision: number;
}

interface ProjectSyncState {
  conflict: ProjectConflict | null;
  setConflict: (conflict: ProjectConflict | null) => void;
}

export const useProjectSyncStore = create<ProjectSyncState>((set) => ({
  conflict: null,
  setConflict: (conflict) => set({ conflict }),
}));
