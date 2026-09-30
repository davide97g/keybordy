/**
 * The real board's corner of the toolbar: a status chip with an LED that
 * says whether the board is on the cable, a Flash button that turns into its
 * own progress bar, and an Attach toggle that streams the board's serial
 * into the monitor's USB tab.
 *
 * Motion follows the sticker vocabulary: plugging the board in slaps the LED
 * on and bursts a ring off the chip, unplugging peels it off. Flash fills
 * left to right while bytes are written, then flashes lime (or shakes pink).
 */

import { useEffect, useRef, useState } from 'react';

import { isClassicEsp32Fqbn, useDeviceStore } from '../../store/useDeviceStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { fqbnForLanguage } from '../../types/board';

import './DeviceDock.css';

type DockState = 'unsupported' | 'unpaired' | 'absent' | 'ready' | 'flashing' | 'attached';

/** How long Flash shows its result before going back to "Flash". */
const RESULT_MS = 2400;

export function DeviceDock() {
  const supported = useDeviceStore((s) => s.supported);
  const paired = useDeviceStore((s) => s.paired);
  const port = useDeviceStore((s) => s.port);
  const portLabel = useDeviceStore((s) => s.portLabel);
  const plugCount = useDeviceStore((s) => s.plugCount);
  const mode = useDeviceStore((s) => s.mode);
  const run = useDeviceStore((s) => s.flash);
  const lastError = useDeviceStore((s) => s.lastError);

  const board = useSimulatorStore(
    (s) => s.boards.find((b) => b.id === s.activeBoardId) ?? s.boards[0],
  );
  const fqbn = board ? fqbnForLanguage(board.boardKind, board.languageMode) : null;
  const flashable = !!board && board.languageMode !== 'micropython' && isClassicEsp32Fqbn(fqbn);

  useEffect(() => {
    useDeviceStore.getState().init();
  }, []);

  // Plug and unplug replay their animations: key the LED on the plug count,
  // and remember an unplug long enough to peel.
  const [peeling, setPeeling] = useState(false);
  const hadPort = useRef(!!port);
  useEffect(() => {
    if (hadPort.current && !port) {
      setPeeling(true);
      const t = setTimeout(() => setPeeling(false), 500);
      hadPort.current = false;
      return () => clearTimeout(t);
    }
    hadPort.current = !!port;
    return undefined;
  }, [port]);

  // Flash result flash: lime "Flashed" or a pink shake, for a beat.
  const [result, setResult] = useState<'done' | 'error' | null>(null);
  const settledRun = useRef<number | null>(null);
  useEffect(() => {
    if (!run?.finishedAt || settledRun.current === run.runId) return undefined;
    settledRun.current = run.runId;
    setResult(run.stage === 'error' ? 'error' : 'done');
    const t = setTimeout(() => setResult(null), RESULT_MS);
    return () => clearTimeout(t);
  }, [run?.finishedAt, run?.runId, run?.stage]);

  const state: DockState = !supported
    ? 'unsupported'
    : mode === 'flashing'
      ? 'flashing'
      : mode === 'attached'
        ? 'attached'
        : port
          ? 'ready'
          : paired
            ? 'absent'
            : 'unpaired';

  const chipLabel = {
    unsupported: 'No USB',
    unpaired: 'Pair board',
    absent: 'Plug in board',
    ready: portLabel || 'USB',
    flashing: 'Flashing',
    attached: 'Live',
  }[state];

  const chipTitle = {
    unsupported: 'Talking to a real board needs Web Serial: open the editor in Chrome or Edge.',
    unpaired: 'Pick the ESP32 on the USB cable once. After that it is found by itself.',
    absent: 'No paired board on USB. Plug it in, or click to pick another port.',
    ready: `ESP32 connected over ${portLabel || 'USB'}. Click to open its serial tab.`,
    flashing: 'Writing the firmware to the board...',
    attached: `Streaming the board's serial over ${portLabel || 'USB'}. Click to open its tab.`,
  }[state];

  const onChip = () => {
    const s = useDeviceStore.getState();
    if (!supported) return;
    if (!port) void s.pair();
    else s.focusMonitor();
  };

  const onFlash = () => {
    if (board) void useDeviceStore.getState().flashBoard(board.id);
  };

  const onAttach = () => {
    const s = useDeviceStore.getState();
    void (mode === 'attached' ? s.detach() : s.attach());
  };

  const writing = mode === 'flashing' && run?.stage === 'write' && run.progress !== null;
  const pct = writing ? Math.round((run?.progress ?? 0) * 100) : 0;
  const flashLabel =
    mode === 'flashing'
      ? writing
        ? `${pct}%`
        : run?.stage === 'build'
          ? 'Building'
          : run?.stage === 'connect'
            ? 'Connecting'
            : run?.stage === 'verify'
              ? 'Verifying'
              : 'Booting'
      : result === 'done'
        ? 'Flashed'
        : result === 'error'
          ? 'Failed'
          : 'Flash';

  const flashTitle = !supported
    ? chipTitle
    : !board
      ? 'Add a board first'
      : !flashable
        ? 'Flashing from the browser supports the classic ESP32 only'
        : mode === 'flashing'
          ? 'Flashing...'
          : port
            ? `Build if needed, then flash ${board.name?.trim() || 'the sketch'} to the board on ${portLabel}`
            : 'Pick the board on USB, then build and flash';

  return (
    <div className="kb-dock" data-state={state}>
      <button
        type="button"
        className={'kb-dock__chip' + (peeling ? ' kb-dock__chip--peel' : '')}
        onClick={onChip}
        disabled={!supported}
        title={chipTitle}
        aria-label={chipTitle}
      >
        <span className="kb-dock__led" key={`led-${plugCount}`} aria-hidden="true" />
        {port && plugCount > 0 && <span className="kb-dock__burst" key={`burst-${plugCount}`} aria-hidden="true" />}
        <span className="kb-dock__label" key={chipLabel}>
          {chipLabel}
        </span>
      </button>

      <button
        type="button"
        className={
          'kb-dock__btn kb-dock__flash' +
          (mode === 'flashing' ? ' kb-dock__flash--busy' : '') +
          (writing && pct >= 55 ? ' kb-dock__flash--filled' : '') +
          (result ? ` kb-dock__flash--${result}` : '')
        }
        onClick={onFlash}
        disabled={!supported || !flashable || mode === 'flashing'}
        title={flashTitle}
        aria-label={flashTitle}
        style={{ '--p': `${pct}%` } as React.CSSProperties}
      >
        <span className="kb-dock__flash-fill" aria-hidden="true" />
        {mode === 'flashing' && !writing ? (
          <svg className="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        ) : result === 'done' ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
            <path d="M13.2 2 4.5 13.6h6.3L9.9 22l8.7-11.6h-6.3L13.2 2z" />
          </svg>
        )}
        <span className="kb-dock__flash-label" key={flashLabel}>
          {flashLabel}
        </span>
      </button>

      <button
        type="button"
        className={'kb-dock__btn kb-dock__attach' + (mode === 'attached' ? ' kb-dock__attach--live' : '')}
        onClick={onAttach}
        disabled={!supported || mode === 'flashing'}
        aria-pressed={mode === 'attached'}
        title={
          mode === 'attached'
            ? 'Detach: stop reading the board and free the port'
            : port
              ? "Attach: stream the board's serial into the monitor"
              : 'Pick the board on USB and stream its serial'
        }
      >
        {mode === 'attached' ? (
          <span className="kb-dock__pulse" aria-hidden="true" />
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 22v-5" />
            <path d="M9 8V2" />
            <path d="M15 8V2" />
            <path d="M18 8v5a6 6 0 0 1-12 0V8z" />
          </svg>
        )}
        <span className="kb-dock__attach-label">{mode === 'attached' ? 'Attached' : 'Attach'}</span>
      </button>

      {lastError && mode !== 'flashing' && (
        <div className="kb-dock__error" role="alert">
          <span>{lastError}</span>
          <button
            type="button"
            onClick={() => useDeviceStore.setState({ lastError: null })}
            aria-label="Dismiss"
          >
            &times;
          </button>
        </div>
      )}
    </div>
  );
}
