/**
 * Shown when a saved project's autosave hits a newer server revision (saved
 * from another tab, or edits made offline on an older copy).
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../store/useProjectStore';
import { useProjectSyncStore } from '../../store/useProjectSyncStore';
import { showMessageDialog } from '../../store/useMessageDialogStore';
import { NameTakenError } from '../../services/projectsApi';
import {
  loadLatest,
  overwriteWithCurrent,
  saveCurrentAsProject,
} from '../../utils/workspacePersistence';
import './ProjectsDialog.css';

export const ProjectConflictDialog: React.FC = () => {
  const { t } = useTranslation();
  const conflict = useProjectSyncStore((s) => s.conflict);
  const name = useProjectStore((s) => s.currentProject?.name ?? s.currentProject?.slug ?? '');
  const [busy, setBusy] = useState(false);

  if (!conflict) return null;

  const run = async (op: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await op();
    } catch (err) {
      showMessageDialog(err instanceof Error ? err.message : String(err), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const saveAsCopy = async () => {
    for (let n = 2; n < 50; n++) {
      try {
        await saveCurrentAsProject(`${name} (${n})`);
        return;
      } catch (err) {
        if (!(err instanceof NameTakenError)) throw err;
      }
    }
  };

  return createPortal(
    <div className="projects-overlay">
      <div className="projects-dialog projects-dialog-narrow" role="alertdialog" aria-modal="true">
        <div className="projects-head">
          <h3 className="projects-title">{t('projects.conflictTitle', 'Changed elsewhere')}</h3>
        </div>
        <div className="projects-conflict-body">
          {t(
            'projects.conflictBody',
            '"{{name}}" was saved from another tab or window since this one loaded it. Your latest edits are kept in this browser until you choose.',
            { name },
          )}
        </div>
        <div className="projects-conflict-actions">
          <button className="projects-btn" disabled={busy} onClick={() => void run(saveAsCopy)}>
            {t('projects.conflictCopy', 'Save mine as a copy')}
          </button>
          <button
            className="projects-btn"
            disabled={busy}
            onClick={() =>
              void run(() => overwriteWithCurrent(conflict.projectId, conflict.serverRevision))
            }
          >
            {t('projects.conflictOverwrite', 'Overwrite with mine')}
          </button>
          <button
            className="projects-btn projects-btn-primary"
            disabled={busy}
            onClick={() => void run(() => loadLatest(conflict.projectId))}
          >
            {t('projects.conflictLoad', 'Load the latest')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
