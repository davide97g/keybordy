/**
 * Keystroke HUD over the canvas: one keycap per `K<n>` pushbutton, lit in
 * that key's cap color while the FIRMWARE says it is down.
 *
 * It reads the active board's serial output, not the canvas clicks, so it
 * shows what the sketch registered: `key N down` / `key N up` from keys8.
 * A click that bounces, or a key whose wiring is wrong, shows up here as a
 * missing or flickering cap. Each `down` also rings the matching part on the
 * canvas (the `kb-key-hit` class, styled in KeyHud.css).
 *
 * While the real board is attached over USB (store/useDeviceStore.ts) it
 * reads the board's serial instead, so pressing a switch on the bench lights
 * the cap and rings the part on the canvas.
 *
 * Hidden unless the active board is running (or the real one is attached)
 * and the circuit has K-labelled keys.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { useDeviceStore } from '../../store/useDeviceStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { keyColorsFromComponents } from '../../utils/boardColors';
import './KeyHud.css';

const KEY_EVENT = /\bkey (\d+) +(down|up)\b/g;

export function KeyHud() {
  const components = useSimulatorStore((s) => s.components);
  const board = useSimulatorStore(
    (s) => s.boards.find((b) => b.id === s.activeBoardId) ?? s.boards[0],
  );
  const attached = useDeviceStore((s) => s.mode === 'attached');
  const deviceOutput = useDeviceStore((s) => s.output);
  const running = attached || !!board?.running;
  const output = attached ? deviceOutput : (board?.serialOutput ?? '');
  // Switching source restarts the parse, like a cleared buffer.
  const source = attached ? 'usb' : 'sim';
  const lastSource = useRef(source);

  const keyColors = useMemo(() => keyColorsFromComponents(components), [components]);
  const keyNumbers = useMemo(() => [...keyColors.keys()].sort((a, b) => a - b), [keyColors]);
  // Component id per key number, for ringing the part on the canvas.
  const keyParts = useMemo(() => {
    const out = new Map<number, string>();
    for (const c of components) {
      const label = typeof c.properties.label === 'string' ? c.properties.label.trim() : '';
      const m = /^K(\d+)$/i.exec(label);
      if (m) out.set(Number(m[1]), c.id);
    }
    return out;
  }, [components]);

  const [held, setHeld] = useState<ReadonlySet<number>>(() => new Set());
  const [strokes, setStrokes] = useState(0);
  const parsedLen = useRef(0);

  // Parse only what arrived since the last render. A shorter buffer means it
  // was cleared (restart, Clear button): start over.
  useEffect(() => {
    let prevEnd = parsedLen.current;
    let next = new Set(held);
    if (lastSource.current !== source) {
      lastSource.current = source;
      // Start from the end: the backlog from before the switch is history.
      parsedLen.current = output.length;
      setHeld(new Set());
      setStrokes(0);
      return;
    }
    if (output.length < prevEnd) {
      prevEnd = 0;
      next = new Set();
      setStrokes(0);
    }
    parsedLen.current = output.length;
    // Back up to the start of the line so an event split across two chunks
    // still matches; events that ended inside the old text were counted.
    const from = output.lastIndexOf('\n', prevEnd - 1) + 1;
    const fresh = output.slice(from);
    if (!fresh.includes('key ')) {
      if (next.size !== held.size) setHeld(next);
      return;
    }

    let downs = 0;
    for (const m of fresh.matchAll(KEY_EVENT)) {
      if (from + (m.index ?? 0) + m[0].length <= prevEnd) continue;
      const n = Number(m[1]);
      if (m[2] === 'down') {
        next.add(n);
        downs += 1;
        // Not for the backlog parsed on mount: only presses happening now.
        if (prevEnd > 0) ringPart(keyParts.get(n), keyColors.get(n));
      } else {
        next.delete(n);
      }
    }
    if (downs) setStrokes((c) => c + downs);
    setHeld(next);
    // `held` and the key maps are read, not reacted to: only new output
    // drives this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [output, source]);

  // Nothing can be held once the board stops.
  useEffect(() => {
    if (!running) setHeld(new Set());
  }, [running]);

  if (!running || keyNumbers.length === 0) return null;

  return (
    <div
      className={'key-hud' + (attached ? ' key-hud--usb' : '')}
      role="status"
      aria-label={attached ? 'Keys the real board reports as down' : 'Keys the firmware reports as down'}
    >
      <span className="key-hud__label" aria-hidden="true">
        {attached ? 'board keys' : 'serial keys'}
      </span>
      <div className="key-hud__caps">
        {keyNumbers.map((n, i) => {
          const down = held.has(n);
          return (
            <span
              key={n}
              className={'key-hud__cap' + (down ? ' key-hud__cap--down' : '')}
              style={{ '--c': keyColors.get(n), '--i': i } as React.CSSProperties}
              aria-label={`K${n} ${down ? 'down' : 'up'}`}
            >
              {n}
            </span>
          );
        })}
      </div>
      <span className="key-hud__count" aria-hidden="true">
        <span className="key-hud__count-num" key={strokes}>
          {strokes}
        </span>{' '}
        {strokes === 1 ? 'press' : 'presses'}
      </span>
    </div>
  );
}

function ringPart(componentId: string | undefined, color: string | undefined) {
  if (!componentId) return;
  const el = document.querySelector<HTMLElement>(
    `[data-component-id="${CSS.escape(componentId)}"]`,
  );
  if (!el) return;
  if (color) el.style.setProperty('--kb-hit-color', color);
  el.classList.remove('kb-key-hit');
  // Force a reflow so a quick second press restarts the ring.
  void el.offsetWidth;
  el.classList.add('kb-key-hit');
  window.setTimeout(() => el.classList.remove('kb-key-hit'), 600);
}
