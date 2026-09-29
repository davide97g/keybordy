/**
 * Mounts the saved-projects UI in the editor: registers the File menu
 * commands, renders the dialogs, and keeps `?id=` in the URL in step with
 * the open saved project.
 */
import { useEffect, useState } from 'react';
import { registerEditorCommand } from '../../lib/editorCommands';
import { useProjectStore } from '../../store/useProjectStore';
import { syncSavedProjectUrl } from '../../utils/workspacePersistence';
import { ProjectConflictDialog } from './ProjectConflictDialog';
import { ProjectsDialog, type ProjectsDialogMode } from './ProjectsDialog';

export const ProjectsHost: React.FC = () => {
  const [mode, setMode] = useState<ProjectsDialogMode | null>(null);

  useEffect(() => {
    const offBrowse = registerEditorCommand('project.browse', () => setMode('browse'));
    const offSaveAs = registerEditorCommand('project.saveAs', () => setMode('saveAs'));
    return () => {
      offBrowse();
      offSaveAs();
    };
  }, []);

  // On changes only: at mount the editor has yet to read `?id=` itself.
  useEffect(
    () =>
      useProjectStore.subscribe((s, prev) => {
        if (s.currentProject !== prev.currentProject) syncSavedProjectUrl(s.currentProject);
      }),
    [],
  );

  return (
    <>
      {mode && <ProjectsDialog key={mode} mode={mode} onClose={() => setMode(null)} />}
      <ProjectConflictDialog />
    </>
  );
};
