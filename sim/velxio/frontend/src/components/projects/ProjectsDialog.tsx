/**
 * Saved projects (Postgres, /api/projects): list, open, rename, delete, and
 * "save current as". Opened from File › Projects… / Save to projects….
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../store/useProjectStore';
import { showConfirmDialog, showMessageDialog } from '../../store/useMessageDialogStore';
import { runEditorCommand } from '../../lib/editorCommands';
import {
  NameTakenError,
  ProjectsUnavailableError,
  deleteProject,
  listProjects,
  renameProject,
  type ProjectSummary,
} from '../../services/projectsApi';
import {
  detachSavedProject,
  dropLocalCopy,
  openSavedProject,
  persistWorkspace,
  saveCurrentAsProject,
} from '../../utils/workspacePersistence';
import './ProjectsDialog.css';

export type ProjectsDialogMode = 'browse' | 'saveAs';

interface Props {
  mode: ProjectsDialogMode;
  onClose: () => void;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function ago(iso: string): string {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return relative.format(0, 'second');
}

function errorText(err: unknown): string {
  if (err instanceof ProjectsUnavailableError) {
    return 'The project store is unreachable. Is the simulator container (and its Postgres) running?';
  }
  return err instanceof Error ? err.message : String(err);
}

function suggestedName(): string {
  const current = useProjectStore.getState().currentProject;
  return current?.name ?? current?.slug ?? 'untitled';
}

export const ProjectsDialog: React.FC<Props> = ({ mode, onClose }) => {
  const { t } = useTranslation();
  const currentId = useProjectStore((s) =>
    s.currentProject?.source === 'saved' ? s.currentProject.id : null,
  );
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState(suggestedName);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setProjects(await listProjects());
      setError(null);
    } catch (err) {
      setProjects(null);
      setError(errorText(err));
    }
  }, []);

  // Mounted per opening (ProjectsHost keys it on the mode).
  useEffect(() => {
    void refresh();
    if (mode === 'saveAs') nameInput.current?.select();
  }, [mode, refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (op: () => Promise<void>) => {
    setBusy(true);
    try {
      await op();
    } catch (err) {
      setError(
        err instanceof NameTakenError
          ? t('projects.nameTaken', 'A project with that name already exists.')
          : errorText(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleSaveAs = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    void run(async () => {
      await saveCurrentAsProject(name);
      onClose();
    });
  };

  const handleOpen = (p: ProjectSummary) =>
    run(async () => {
      // Whatever is on screen goes to its own slot before it is replaced.
      await persistWorkspace();
      const result = await openSavedProject(p.id);
      if (result === 'not-found') {
        await refresh();
        return;
      }
      if (result === 'unavailable') throw new ProjectsUnavailableError();
      onClose();
    });

  const handleRename = (e: React.FormEvent) => {
    e.preventDefault();
    if (!renaming) return;
    const name = renaming.name.trim();
    if (!name) return;
    void run(async () => {
      const updated = await renameProject(renaming.id, name);
      const store = useProjectStore.getState();
      if (store.currentProject?.id === updated.id) {
        store.setCurrentProject({ ...store.currentProject, name: updated.name });
      }
      setRenaming(null);
      await refresh();
    });
  };

  const handleDelete = async (p: ProjectSummary) => {
    const ok = await showConfirmDialog(
      t('projects.deleteConfirm', 'Delete "{{name}}" from saved projects? This cannot be undone.', {
        name: p.name,
      }),
      { danger: true, confirmLabel: t('projects.delete', 'Delete') },
    );
    if (!ok) return;
    void run(async () => {
      await deleteProject(p.id);
      await dropLocalCopy(p.id);
      if (p.id === currentId) {
        await detachSavedProject();
        showMessageDialog(
          t(
            'projects.deletedOpen',
            'The open project was deleted. Its content stays on screen as a browser draft.',
          ),
        );
      }
      await refresh();
    });
  };

  return createPortal(
    <div className="projects-overlay" onClick={onClose}>
      <div
        className="projects-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="projects-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="projects-head">
          <h3 id="projects-title" className="projects-title">
            {mode === 'saveAs'
              ? t('projects.saveAsTitle', 'Save to projects')
              : t('projects.title', 'Projects')}
          </h3>
          <p className="projects-sub">
            {t('projects.subtitle', 'Saved in the local Postgres. Open projects autosave to it.')}
          </p>
        </div>

        <form className="projects-save-as" onSubmit={handleSaveAs}>
          <input
            ref={nameInput}
            className="projects-input"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={120}
            placeholder={t('projects.namePlaceholder', 'Project name')}
            aria-label={t('projects.namePlaceholder', 'Project name')}
          />
          <button
            type="submit"
            className="projects-btn projects-btn-primary"
            disabled={busy || !newName.trim()}
          >
            {t('projects.saveCurrent', 'Save current as new')}
          </button>
        </form>

        {error && <div className="projects-error">{error}</div>}

        <div className="projects-body">
          {projects?.length === 0 && (
            <div className="projects-empty">{t('projects.empty', 'No saved projects yet.')}</div>
          )}
          {projects?.map((p) => (
            <div
              key={p.id}
              className={`projects-row${p.id === currentId ? ' projects-row-current' : ''}`}
            >
              {renaming?.id === p.id ? (
                <form className="projects-rename" onSubmit={handleRename}>
                  <input
                    className="projects-input"
                    autoFocus
                    value={renaming.name}
                    maxLength={120}
                    onChange={(e) => setRenaming({ id: p.id, name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        setRenaming(null);
                      }
                    }}
                  />
                  <button type="submit" className="projects-btn" disabled={busy}>
                    {t('projects.renameSave', 'Rename')}
                  </button>
                </form>
              ) : (
                <button
                  className="projects-open"
                  onClick={() => void handleOpen(p)}
                  disabled={busy}
                >
                  <span className="projects-name">{p.name}</span>
                  <span className="projects-meta">
                    {p.boardKinds.join(', ') || t('projects.noBoards', 'no boards')} ·{' '}
                    {ago(p.updatedAt)}
                    {p.sourceFolder && (
                      <span className="projects-badge">
                        {t('projects.fromFolder', 'from {{folder}}', { folder: p.sourceFolder })}
                      </span>
                    )}
                    {p.id === currentId && (
                      <span className="projects-badge projects-badge-open">
                        {t('projects.open', 'open')}
                      </span>
                    )}
                  </span>
                </button>
              )}
              {renaming?.id !== p.id && (
                <div className="projects-actions">
                  <button
                    className="projects-btn"
                    disabled={busy}
                    onClick={() => setRenaming({ id: p.id, name: p.name })}
                  >
                    {t('projects.rename', 'Rename')}
                  </button>
                  <button
                    className="projects-btn projects-btn-danger"
                    disabled={busy}
                    onClick={() => void handleDelete(p)}
                  >
                    {t('projects.delete', 'Delete')}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="projects-foot">
          <button
            className="projects-btn"
            onClick={() => {
              onClose();
              runEditorCommand('project.new');
            }}
          >
            {t('editor.menu.newProject', 'New workspace')}
          </button>
          <button className="projects-btn" onClick={onClose}>
            {t('projects.close', 'Close')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
