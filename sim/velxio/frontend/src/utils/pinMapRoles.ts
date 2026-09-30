/**
 * What a pin does, for the pin map (components/simulator/PinMapPanel.tsx).
 *
 * A board GPIO's direction, pull and level come from its PinManager, which
 * the ESP32 bridges fill from the guest's pad config, so they exist only once
 * the sketch has run. The last values a run left are kept per pad and shown
 * as not live, because PinManager clears its pads when the run stops.
 */

import { getBoardPinManager } from '../store/useSimulatorStore';
import { boardPinToNumber } from './boardPinMapping';

export type RoleKind = 'in' | 'out' | 'gnd' | 'pwr' | 'uart' | 'gpio' | 'ctl' | 'none';

export interface PinRole {
  kind: RoleKind;
  /** Chip text: IN, OUT, GND, 3V3, GPIO … */
  text: string;
  /** Pull and level, e.g. "PULLUP · HIGH". */
  detail?: string;
  /** False when the values are what the last run left, not the running pad. */
  live?: boolean;
}

export interface PinInfoEntry {
  name: string;
  description?: string;
  signals?: Array<{ type?: string; signal?: string }>;
}

// Direction, pull and level a run left on each board pad, keyed boardId:gpio.
const lastSeen = new Map<string, { dir: 0 | 1; pull: 0 | 1 | 2; level?: boolean }>();

const SUPPLY_RE = /^(3V3|3\.3V|3V|5V|VIN|VCC|VBUS|IOREF|AREF)/i;

function levelText(level: boolean | undefined): string | undefined {
  return level === undefined ? undefined : level ? 'HIGH' : 'LOW';
}

export function boardPinRole(boardId: string, boardKind: string, pinName: string, running: boolean): PinRole {
  const gpio = boardPinToNumber(boardKind, pinName);
  if (gpio === null || gpio < 0) {
    if (/^GND/i.test(pinName)) return { kind: 'gnd', text: 'GND' };
    if (SUPPLY_RE.test(pinName)) return { kind: 'pwr', text: pinName.toUpperCase() };
    if (/^(EN|RST|RESET)$/i.test(pinName)) return { kind: 'ctl', text: pinName.toUpperCase() };
    return { kind: 'none', text: '—' };
  }
  if (/^(TX|RX)\d?$/i.test(pinName)) return { kind: 'uart', text: pinName.toUpperCase().replace(/\d$/, '') };

  const key = `${boardId}:${gpio}`;
  const pm = getBoardPinManager(boardId);
  const dir = pm?.getPinDirection(gpio);
  let seen = lastSeen.get(key);
  let live = false;
  if (pm && dir !== undefined) {
    seen = { dir, pull: pm.getPinPull(gpio), level: pm.peekPinState(gpio) };
    lastSeen.set(key, seen);
    live = running;
  }
  if (!seen) return { kind: 'gpio', text: 'GPIO' };
  const pull = seen.pull === 1 ? 'PULLUP' : seen.pull === 2 ? 'PULLDOWN' : undefined;
  if (seen.dir === 1) return { kind: 'out', text: 'OUT', detail: levelText(seen.level), live };
  return {
    kind: 'in',
    text: 'IN',
    detail: [pull, levelText(seen.level)].filter(Boolean).join(' · ') || undefined,
    live,
  };
}

/** A part pin's own role, from its pinInfo signals (GND and supply pins). */
export function partPinRole(entry: PinInfoEntry | undefined): PinRole {
  const power = entry?.signals?.find((s) => s?.type === 'power');
  if (power?.signal === 'GND') return { kind: 'gnd', text: 'GND' };
  if (power) return { kind: 'pwr', text: power.signal || 'PWR' };
  return { kind: 'none', text: '' };
}

/** '32' reads as D32 (the DevKit silk); anything named already stays as is. */
export function boardPinLabel(pinName: string): string {
  return /^\d+$/.test(pinName) ? `D${pinName}` : pinName;
}


/** Forget what earlier runs left (tests, and a project switch). */
export function clearLastSeenPins(): void {
  lastSeen.clear();
}
