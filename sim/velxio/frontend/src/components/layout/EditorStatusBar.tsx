/**
 * keybordy status bar: one thin strip under the editor that says whether the
 * simulation is running, on which board, at what baud, and which file is
 * open. It turns lime while the board runs so the state reads from across
 * the room.
 */
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { useEditorStore } from '../../store/useEditorStore';
import { boardDisplayName } from '../../types/board';
import './EditorStatusBar.css';

export function EditorStatusBar() {
  const boards = useSimulatorStore((s) => s.boards);
  const activeBoardId = useSimulatorStore((s) => s.activeBoardId);
  const files = useEditorStore((s) => s.files);
  const activeFileId = useEditorStore((s) => s.activeFileId);

  const board = boards.find((b) => b.id === activeBoardId) ?? boards[0];
  const running = boards.some((b) => b.running);
  const file = files.find((f) => f.id === activeFileId);
  const state = running ? 'Running' : board?.compiledProgram ? 'Built' : 'Stopped';

  return (
    <footer
      className={'editor-status' + (running ? ' editor-status--live' : '')}
      aria-live="polite"
    >
      <span className="editor-status-state">{state}</span>
      {board && <span>{boardDisplayName(board)}</span>}
      {board && board.serialBaudRate > 0 && (
        <span>{board.serialBaudRate.toLocaleString()} baud</span>
      )}
      <span className="editor-status-spacer" />
      {file && (
        <span>
          {file.name}
          {file.modified ? ' · edited' : ''}
        </span>
      )}
    </footer>
  );
}
