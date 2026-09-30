/**
 * The real board on the USB cable, seen through Web Serial.
 *
 * Three jobs, one port:
 *   - presence: which granted port is plugged in right now. Chrome only
 *     reports ports this origin was granted, so the first time the user has
 *     to pair the board from a click (`pair`). After that, plugging and
 *     unplugging fire `connect` / `disconnect` and the toolbar follows.
 *   - flash: build if the code changed, then write the image with
 *     esptool-js (lib/esp32Flash.ts), then attach and reset so the card can
 *     show the board's first words.
 *   - monitor: `attach` opens the port at 115200 and appends what the board
 *     prints to `output`, which the serial monitor's USB tab and the key HUD
 *     read. The port is exclusive: flashing detaches first.
 */

import { create } from 'zustand';

import { base64ToBytes, flashEsp32, type FlashPhase } from '../lib/esp32Flash';
import { compileBoardForFlash, isCompiledProgramStale } from '../utils/boardCompile';
import { useSimulatorStore } from './useSimulatorStore';

const BAUD = 115200;
/** Keep the device log bounded; the tail is what anyone reads. */
const OUTPUT_CAP = 200_000;
/** How long the flash card waits for the board's first line after reset. */
const BOOT_WAIT_MS = 4000;
/** How long a finished flash stays on the card. */
const LINGER_MS = 5000;
const PAIRED_KEY = 'kb-device-paired';

/** USB-UART bridges found on ESP32 dev boards. Filters the port picker. */
const BRIDGES: { vid: number; pid?: number; label: string }[] = [
  { vid: 0x10c4, pid: 0xea60, label: 'CP2102' },
  { vid: 0x1a86, pid: 0x7523, label: 'CH340' },
  { vid: 0x1a86, pid: 0x55d4, label: 'CH9102' },
  { vid: 0x0403, pid: 0x6001, label: 'FT232' },
  { vid: 0x0403, pid: 0x6015, label: 'FT231X' },
  { vid: 0x303a, label: 'ESP32 USB' },
];

export type DeviceMode = 'idle' | 'flashing' | 'attached';

export type FlashStage = 'build' | FlashPhase | 'boot' | 'done' | 'error';

export interface FlashRun {
  runId: number;
  boardLabel: string;
  startedAt: number;
  finishedAt: number | null;
  stage: FlashStage;
  /** 0..1 while writing; null when there is no honest fraction. */
  progress: number | null;
  lastLine: string;
  /** Stages this run went through, in order (a fresh build skips `build`). */
  stages: FlashStage[];
  error: string | null;
  chip: string | null;
  /** The first line the board printed after the reset, if any. */
  bootLine: string | null;
}

interface DeviceState {
  supported: boolean;
  /** A port this origin was granted at some point (persisted flag). */
  paired: boolean;
  port: SerialPort | null;
  portLabel: string;
  /** Bumps on every plug-in, so the toolbar can replay its slap. */
  plugCount: number;
  mode: DeviceMode;
  output: string;
  flash: FlashRun | null;
  lastError: string | null;
  /** Bumps when something asks for the USB tab of the serial monitor. */
  monitorFocus: number;

  init: () => void;
  pair: () => Promise<SerialPort | null>;
  flashBoard: (boardId: string) => Promise<void>;
  attach: () => Promise<void>;
  detach: () => Promise<void>;
  reset: () => Promise<void>;
  write: (text: string) => Promise<void>;
  clearOutput: () => void;
  dismissFlash: () => void;
  focusMonitor: () => void;
}

function serial(): Serial | null {
  return typeof navigator !== 'undefined' && 'serial' in navigator ? navigator.serial : null;
}

function readPaired(): boolean {
  try {
    return localStorage.getItem(PAIRED_KEY) === '1';
  } catch {
    return false;
  }
}

function writePaired(): void {
  try {
    localStorage.setItem(PAIRED_KEY, '1');
  } catch {
    // Private window: the flag only picks the wording of an empty state.
  }
}

function bridgeFor(port: SerialPort) {
  const { usbVendorId: vid, usbProductId: pid } = port.getInfo();
  return BRIDGES.find((b) => b.vid === vid && (b.pid === undefined || b.pid === pid));
}

function labelFor(port: SerialPort): string {
  const bridge = bridgeFor(port);
  if (bridge) return bridge.label;
  const { usbVendorId: vid, usbProductId: pid } = port.getInfo();
  return vid !== undefined
    ? `USB ${vid.toString(16).padStart(4, '0')}:${(pid ?? 0).toString(16).padStart(4, '0')}`
    : 'Serial port';
}

/** Classic ESP32 FQBNs: the flasher refuses S2/S3/C3/C6/H2/P4 images. */
export function isClassicEsp32Fqbn(fqbn: string | null | undefined): boolean {
  if (!fqbn?.startsWith('esp32:esp32:')) return false;
  const board = fqbn.split(':')[2] ?? '';
  return !/(s2|s3|c2|c3|c5|c6|h2|p4)/i.test(board);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Monitor internals live outside the store: they are handles, not state.
let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let readLoopDone: Promise<void> | null = null;
let pending = '';
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lingerTimer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;

/** ROM and IDF chatter printed before the sketch runs. */
const BOOT_NOISE =
  /^(rst:|ets |configsip|clk_drv|mode:|load:|entry |ho \d|[WEID] \(\d+\)|boot:|csum|---)/;

export const useDeviceStore = create<DeviceState>((set, get) => {
  const append = (text: string) => {
    // A reset glitch reads as a burst of invalid bytes; drop the U+FFFD they
    // decode to rather than printing a row of boxes.
    // Arduino's println ends lines with \r\n; keep only the \n so the line
    // regexes (key events, the boot-line wait) see clean lines.
    pending += text.replace(/\uFFFD/g, '').replace(/\r(?=\n|$)/g, '');
    if (flushTimer) return;
    // setTimeout, not rAF: rAF stops in a background tab and the log would
    // pile up unseen until the tab came back.
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (!pending) return;
      const next = get().output + pending;
      pending = '';
      set({ output: next.length > OUTPUT_CAP ? next.slice(next.length - OUTPUT_CAP) : next });
    }, 40);
  };

  const refresh = async () => {
    const api = serial();
    if (!api) return;
    const ports = await api.getPorts();
    // Prefer a known ESP32 bridge when several ports are granted.
    const port = ports.find((p) => bridgeFor(p)) ?? ports[0] ?? null;
    const prev = get().port;
    if (port === prev) return;
    set({
      port,
      portLabel: port ? labelFor(port) : '',
      paired: get().paired || ports.length > 0,
      plugCount: port && !prev ? get().plugCount + 1 : get().plugCount,
    });
    if (ports.length > 0) writePaired();
  };

  const closeMonitor = async () => {
    const r = reader;
    reader = null;
    if (r) {
      try {
        await r.cancel();
      } catch {
        // The device vanished mid-read; the stream is already errored.
      }
    }
    await readLoopDone;
    readLoopDone = null;
    const port = get().port;
    if (port?.readable || port?.writable) {
      try {
        await port.close();
      } catch {
        // Already closed.
      }
    }
  };

  const openMonitor = async (port: SerialPort) => {
    await port.open({ baudRate: BAUD });
    // Both lines released: EN high, IO0 high. A DevKit's auto-reset circuit
    // then leaves the running firmware alone.
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    const r = port.readable!.getReader();
    reader = r;
    const decoder = new TextDecoder();
    readLoopDone = (async () => {
      try {
        for (;;) {
          const { value, done } = await r.read();
          if (done) break;
          if (value) append(decoder.decode(value, { stream: true }));
        }
      } catch {
        // Unplugged while attached: the disconnect handler reports it.
      } finally {
        try {
          r.releaseLock();
        } catch {
          // Lock already released by cancel().
        }
      }
    })();
  };

  const pulseReset = async (port: SerialPort) => {
    // RTS asserted with DTR released pulls EN low: a clean hardware reset
    // that boots the app, since IO0 stays high.
    await port.setSignals({ dataTerminalReady: false, requestToSend: true });
    await sleep(120);
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
  };

  const patchFlash = (patch: Partial<FlashRun>) => {
    const cur = get().flash;
    if (!cur) return;
    const stage = patch.stage;
    const stages =
      stage && !cur.stages.includes(stage) && stage !== 'error' ? [...cur.stages, stage] : cur.stages;
    set({ flash: { ...cur, ...patch, stages } });
  };

  const scheduleLinger = () => {
    if (lingerTimer) clearTimeout(lingerTimer);
    lingerTimer = setTimeout(() => {
      lingerTimer = null;
      if (get().flash?.finishedAt && get().flash?.stage === 'done') set({ flash: null });
    }, LINGER_MS);
  };

  /** First sketch line printed after `from` in the device log, or null. */
  const waitForBootLine = async (from: number): Promise<string | null> => {
    const deadline = Date.now() + BOOT_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(100);
      const lines = get().output.slice(from).split(/\r?\n/);
      // The last piece may be a partial line; only complete ones count.
      for (const raw of lines.slice(0, -1)) {
        const line = raw.replace(/[\x00-\x1f\x7f]/g, '').trim();
        if (line && !BOOT_NOISE.test(line)) return line;
      }
    }
    return null;
  };

  return {
    supported: serial() !== null && (typeof isSecureContext === 'undefined' || isSecureContext),
    paired: readPaired(),
    port: null,
    portLabel: '',
    plugCount: 0,
    mode: 'idle',
    output: '',
    flash: null,
    lastError: null,
    monitorFocus: 0,

    init() {
      const api = serial();
      if (!api || initialized) return;
      initialized = true;
      api.addEventListener('connect', () => void refresh());
      api.addEventListener('disconnect', (e) => {
        const gone = e.target as SerialPort | null;
        if (gone && gone === get().port && get().mode === 'attached') {
          append('\n[board unplugged]\n');
          reader = null;
          set({ mode: 'idle' });
        }
        void refresh();
      });
      void refresh();
    },

    async pair() {
      const api = serial();
      if (!api) return null;
      try {
        const port = await api.requestPort({
          filters: BRIDGES.map((b) =>
            b.pid === undefined ? { usbVendorId: b.vid } : { usbVendorId: b.vid, usbProductId: b.pid },
          ),
        });
        writePaired();
        set({
          port,
          portLabel: labelFor(port),
          paired: true,
          plugCount: get().port === port ? get().plugCount : get().plugCount + 1,
          lastError: null,
        });
        return port;
      } catch {
        // The user closed the picker: not an error worth a banner.
        return null;
      }
    },

    async flashBoard(boardId) {
      if (get().mode === 'flashing') return;
      const board = useSimulatorStore.getState().boards.find((b) => b.id === boardId);
      if (!board) return;
      // The picker needs this click's user gesture, so ask before building.
      const port = get().port ?? (await get().pair());
      if (!port) return;

      if (lingerTimer) clearTimeout(lingerTimer);
      const wasAttached = get().mode === 'attached';
      if (wasAttached) await closeMonitor();

      const needsBuild =
        !board.compiledProgram ||
        board.compiledProgram === 'micropython-loaded' ||
        isCompiledProgramStale(board);
      const runId = (get().flash?.runId ?? 0) + 1;
      set({
        mode: 'flashing',
        lastError: null,
        flash: {
          runId,
          boardLabel: board.name?.trim() || 'ESP32',
          startedAt: Date.now(),
          finishedAt: null,
          stage: needsBuild ? 'build' : 'connect',
          progress: null,
          lastLine: needsBuild ? 'Building the sketch...' : 'Opening the port...',
          stages: [needsBuild ? 'build' : 'connect'],
          error: null,
          chip: null,
          bootLine: null,
        },
      });

      const fail = (message: string) => {
        patchFlash({ stage: 'error', error: message, finishedAt: Date.now(), progress: null });
        // The card shows the error; the toolbar banner is for attach failures.
        set({ mode: 'idle' });
      };

      let program = board.compiledProgram;
      if (needsBuild) {
        const outcome = await compileBoardForFlash(board, (line) => patchFlash({ lastLine: line }));
        if (!outcome.ok) return fail(`Build failed: ${outcome.error}`);
        program = outcome.program;
      }
      if (!program) return fail('No firmware to flash.');

      let result;
      try {
        result = await flashEsp32(port, base64ToBytes(program), {
          onPhase: (phase) =>
            patchFlash({
              stage: phase,
              progress: phase === 'write' ? 0 : phase === 'connect' ? null : 1,
              lastLine:
                phase === 'connect'
                  ? 'Entering the bootloader...'
                  : phase === 'verify'
                    ? 'Checking the flash hash...'
                    : phase === 'reset'
                      ? 'Resetting the board...'
                      : get().flash?.lastLine,
            }),
          onProgress: (fraction) => patchFlash({ progress: fraction }),
          onLine: (line) => {
            const chip = /^Chip is (.+)$/.exec(line)?.[1];
            patchFlash(chip ? { lastLine: line, chip } : { lastLine: line });
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return fail(
          /Failed to connect|timed out|Invalid head/i.test(msg)
            ? `Could not reach the bootloader. Hold BOOT while flashing, or check the cable. (${msg})`
            : /Failed to open|already open|NetworkError/i.test(msg)
              ? 'The port is busy. Close any other serial monitor (Arduino IDE, arduino-cli, screen) and try again.'
              : msg,
        );
      }

      // Attach and reset so the card can show the sketch actually running.
      patchFlash({ stage: 'boot', progress: null, chip: result.chip, lastLine: 'Waiting for the board...' });
      const from = get().output.length + pending.length;
      let bootLine: string | null = null;
      try {
        await openMonitor(port);
        set({ mode: 'attached' });
        get().focusMonitor();
        await pulseReset(port);
        bootLine = await waitForBootLine(from);
      } catch {
        set({ mode: 'idle' });
      }
      patchFlash({
        stage: 'done',
        finishedAt: Date.now(),
        bootLine,
        lastLine: bootLine
          ? `Board says: ${bootLine}`
          : `Wrote ${(result.bytes / 1024).toFixed(0)} KB, verified.`,
      });
      scheduleLinger();
    },

    async attach() {
      if (get().mode !== 'idle') return;
      const port = get().port ?? (await get().pair());
      if (!port) return;
      try {
        await openMonitor(port);
        set({ mode: 'attached', lastError: null });
        get().focusMonitor();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set({
          lastError: /Failed to open|already open/i.test(msg)
            ? 'The port is busy. Close any other serial monitor and try again.'
            : msg,
        });
      }
    },

    async detach() {
      if (get().mode !== 'attached') return;
      await closeMonitor();
      set({ mode: 'idle' });
    },

    async reset() {
      const port = get().port;
      if (!port || get().mode !== 'attached') return;
      await pulseReset(port);
    },

    async write(text) {
      const port = get().port;
      if (!port?.writable || get().mode !== 'attached') return;
      const w = port.writable.getWriter();
      try {
        await w.write(new TextEncoder().encode(text));
      } finally {
        w.releaseLock();
      }
    },

    clearOutput() {
      pending = '';
      set({ output: '' });
    },

    dismissFlash() {
      if (get().mode === 'flashing') return;
      if (lingerTimer) clearTimeout(lingerTimer);
      set({ flash: null });
    },

    focusMonitor() {
      const sim = useSimulatorStore.getState();
      if (!sim.serialMonitorOpen) sim.toggleSerialMonitor();
      set({ monitorFocus: get().monitorFocus + 1 });
    },
  };
});
