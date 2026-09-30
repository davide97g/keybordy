/**
 * keybordy status bar: one thin strip under the editor that says whether the
 * simulation is running, on which board, at what baud, and which file is
 * open. It turns lime while the board runs so the state reads from across
 * the room. On the right, a USB item says whether the real board is on the
 * cable, attached, or being flashed.
 */
import { useDeviceStore } from '../../store/useDeviceStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { useEditorStore } from '../../store/useEditorStore';
import { boardDisplayName } from '../../types/board';
import './EditorStatusBar.css';

export function EditorStatusBar() {
  const boards = useSimulatorStore((s) => s.boards);
  const activeBoardId = useSimulatorStore((s) => s.activeBoardId);
  const files = useEditorStore((s) => s.files);
  const activeFileId = useEditorStore((s) => s.activeFileId);
  const deviceSupported = useDeviceStore((s) => s.supported);
  const devicePort = useDeviceStore((s) => s.port);
  const devicePortLabel = useDeviceStore((s) => s.portLabel);
  const deviceMode = useDeviceStore((s) => s.mode);

  const board = boards.find((b) => b.id === activeBoardId) ?? boards[0];
  const running = boards.some((b) => b.running);
  const file = files.find((f) => f.id === activeFileId);
  const state = running ? 'Running' : board?.compiledProgram ? 'Built' : 'Stopped';

  return (
    <footer
      className={'editor-status' + (running ? ' editor-status--live' : '')}
      aria-live="polite"
    >
      {/* Keyed on the state so every change stamps the new word in. */}
      <span className="editor-status-state" key={state}>
        {state}
      </span>
      {board && <span>{boardDisplayName(board)}</span>}
      {board && board.serialBaudRate > 0 && (
        <span>{board.serialBaudRate.toLocaleString()} baud</span>
      )}
      <span className="editor-status-spacer" />
      {deviceSupported && (
        <span
          className={'editor-status-usb editor-status-usb--' + (devicePort ? deviceMode : 'none')}
          key={devicePort ? deviceMode : 'none'}
        >
          <span className="editor-status-usb-led" aria-hidden="true" />
          {!devicePort
            ? 'USB: no board'
            : deviceMode === 'flashing'
              ? `USB: flashing (${devicePortLabel})`
              : deviceMode === 'attached'
                ? `USB: attached (${devicePortLabel})`
                : `USB: ${devicePortLabel}`}
        </span>
      )}
      {file && (
        <span>
          {file.name}
          {file.modified && <span className="editor-status-edited"> · edited</span>}
        </span>
      )}
    </footer>
  );
}
