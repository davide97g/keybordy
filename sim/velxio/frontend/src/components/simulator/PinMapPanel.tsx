/**
 * Pin map — the right-hand overlay a left click on a part or board opens.
 *
 * It lists every pin of the part with where its wire goes, grouped by what
 * the pin does: inputs the board reads, outputs it drives, power and ground,
 * then the pins nothing is wired to. A board GPIO's direction, pull and level
 * come from its PinManager, which the ESP32 bridges feed from the guest's pad
 * config, so they are known only once the sketch has run; the last values a
 * run left are kept and shown as such. A part's pins borrow the role of the
 * board pin at the far end of their wire, so a key's leg reads "D32 · IN
 * PULLUP" without the part knowing anything about the firmware.
 *
 * The canvas follows along through usePinMapStore: the part's wires glow and
 * the rest dim (WireLayer), and the parts at the far ends get a ring in their
 * wire's color. Hovering a row narrows all of that to one pin.
 */

import React, { useEffect, useReducer, useState } from 'react';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { usePinMapStore, type PinMapTarget } from '../../store/usePinMapStore';
import { ComponentRegistry } from '../../services/ComponentRegistry';
import { boardPinToNumber } from '../../utils/boardPinMapping';
import {
  boardPinLabel,
  boardPinRole,
  partPinRole,
  type PinInfoEntry,
  type PinRole,
  type RoleKind,
} from '../../utils/pinMapRoles';
import { readPinInfo } from '../../utils/readPinInfo';
import { boardDisplayName } from '../../types/board';
import { isEsp32Family } from '../../types/boardOptions';
import type { Wire } from '../../types/wire';
import './PinMapPanel.css';

interface PinLink {
  wire: Wire;
  peer: PinMapTarget | null;
  peerLabel: string;
  peerPin: string;
  peerRole?: PinRole;
}

interface PinRow {
  pin: string;
  label: string;
  sub?: string;
  role: PinRole;
  links: PinLink[];
}

function componentLabel(c: { id: string; metadataId: string; properties: Record<string, unknown> }) {
  const label = typeof c.properties?.label === 'string' ? c.properties.label.trim() : '';
  const meta = ComponentRegistry.getInstance().getById(c.metadataId);
  return { title: label || meta?.name || c.metadataId, name: meta?.name || c.metadataId };
}

function RoleChip({ role }: { role: PinRole }) {
  if (role.kind === 'none' && !role.text) return null;
  return (
    <span className={`pin-map__role pin-map__role--${role.kind}`}>
      <span className="pin-map__role-text">{role.text}</span>
      {role.detail && <span className="pin-map__role-detail">{role.detail}</span>}
    </span>
  );
}

/** Which way the signal goes along the wire, seen from the mapped part. */
function flowArrow(rowRole: PinRole, peerRole: PinRole | undefined, mappedIsBoard: boolean) {
  const r = mappedIsBoard ? rowRole : peerRole;
  if (!r) return '—';
  if (r.kind === 'in') return mappedIsBoard ? '←' : '→';
  if (r.kind === 'out') return mappedIsBoard ? '→' : '←';
  return '—';
}

const SECTIONS: Array<{ id: string; title: string; kinds: RoleKind[] }> = [
  { id: 'in', title: 'Inputs · board reads', kinds: ['in'] },
  { id: 'out', title: 'Outputs · board drives', kinds: ['out'] },
  { id: 'power', title: 'Power & ground', kinds: ['gnd', 'pwr'] },
  { id: 'other', title: 'Wired', kinds: ['gpio', 'uart', 'ctl', 'none'] },
];

interface PinMapPanelProps {
  /** Selects a part named in a row, so the map can walk the circuit. */
  onNavigate: (target: PinMapTarget) => void;
}

export function PinMapPanel({ onNavigate }: PinMapPanelProps) {
  const target = usePinMapStore((s) => s.target);
  const hoverPin = usePinMapStore((s) => s.hoverPin);
  const setHoverPin = usePinMapStore((s) => s.setHoverPin);
  const close = usePinMapStore((s) => s.close);
  const wires = useSimulatorStore((s) => s.wires);
  const components = useSimulatorStore((s) => s.components);
  const boards = useSimulatorStore((s) => s.boards);
  // Which part's "Not connected" list is open, so it folds again on a new part.
  const [unwiredOpenFor, setUnwiredOpenFor] = useState<string | null>(null);
  const [, tick] = useReducer((x: number) => x + 1, 0);

  const anyRunning = boards.some((b) => b.running);

  // Pads move while a sketch runs; nothing announces a level change to React
  // here, so sample them a few times a second while the panel is open.
  useEffect(() => {
    if (!target || !anyRunning) return;
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  }, [target, anyRunning]);

  // The pin list is read from the element after it mounts.
  useEffect(() => {
    if (!target) return;
    const id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [target]);

  const board = target?.kind === 'board' ? boards.find((b) => b.id === target.id) : undefined;
  const component =
    target?.kind === 'component' ? components.find((c) => c.id === target.id) : undefined;
  const missing = Boolean(target) && !board && !component;

  // The part was deleted (or the project changed) under the panel.
  useEffect(() => {
    if (missing) close();
  }, [missing, close]);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [target, close]);

  const describePeer = (componentId: string, pinName: string): Omit<PinLink, 'wire'> => {
    const b = boards.find((x) => x.id === componentId);
    if (b) {
      return {
        peer: { kind: 'board', id: b.id },
        peerLabel: boardDisplayName(b),
        peerPin: boardPinLabel(pinName),
        peerRole: boardPinRole(b.id, b.boardKind, pinName, Boolean(b.running)),
      };
    }
    const c = components.find((x) => x.id === componentId);
    if (c) {
      const entries = readPinInfo<PinInfoEntry>(document.getElementById(c.id)) ?? [];
      const role = partPinRole(entries.find((p) => p.name === pinName));
      return {
        peer: { kind: 'component', id: c.id },
        peerLabel: componentLabel(c).title,
        peerPin: pinName,
        peerRole: role.kind === 'none' ? undefined : role,
      };
    }
    return { peer: null, peerLabel: componentId, peerPin: pinName };
  };

  const rows: PinRow[] = [];
  if (target && (board || component)) {
    const entries = readPinInfo<PinInfoEntry>(document.getElementById(target.id)) ?? [];
    const names: string[] = [];
    const byName = new Map<string, PinInfoEntry>();
    for (const p of entries) {
      if (byName.has(p.name)) continue;
      byName.set(p.name, p);
      names.push(p.name);
    }
    // A wire can name a pin the element no longer reports; list it anyway.
    for (const w of wires) {
      for (const e of [w.start, w.end]) {
        if (e.componentId === target.id && !byName.has(e.pinName) && !names.includes(e.pinName)) {
          names.push(e.pinName);
        }
      }
    }
    const esp = board ? isEsp32Family(board.boardKind) : false;
    for (const pin of names) {
      const links: PinLink[] = [];
      for (const w of wires) {
        if (w.start.componentId === target.id && w.start.pinName === pin) {
          links.push({ wire: w, ...describePeer(w.end.componentId, w.end.pinName) });
        } else if (w.end.componentId === target.id && w.end.pinName === pin) {
          links.push({ wire: w, ...describePeer(w.start.componentId, w.start.pinName) });
        }
      }
      if (board) {
        const gpio = boardPinToNumber(board.boardKind, pin);
        const label = boardPinLabel(pin);
        rows.push({
          pin,
          label,
          sub: esp && gpio !== null && gpio >= 0 ? `GPIO${gpio}` : undefined,
          role: boardPinRole(board.id, board.boardKind, pin, Boolean(board.running)),
          links,
        });
      } else {
        rows.push({ pin, label: pin, role: partPinRole(byName.get(pin)), links });
      }
    }
  }

  const wired = rows.filter((r) => r.links.length > 0);
  const unwired = rows.filter((r) => r.links.length === 0);

  // Ring the mapped part and the parts its wires reach, in the wire's color.
  // Rows are rebuilt every render, so the effect keys on the rings' JSON.
  type Ring = { kind: PinMapTarget['kind']; id: string; role: 'self' | 'peer'; color?: string };
  const rings: Ring[] = [];
  if (target) {
    rings.push({ kind: target.kind, id: target.id, role: 'self' });
    const seen = new Set<string>([target.id]);
    for (const r of wired) {
      if (hoverPin && r.pin !== hoverPin) continue;
      for (const l of r.links) {
        if (!l.peer || seen.has(l.peer.id)) continue;
        seen.add(l.peer.id);
        rings.push({ ...l.peer, role: 'peer', color: l.wire.color });
      }
    }
  }
  const ringsKey = JSON.stringify(rings);

  useEffect(() => {
    const els: HTMLElement[] = [];
    for (const r of JSON.parse(ringsKey) as Ring[]) {
      const el =
        r.kind === 'component'
          ? document.querySelector<HTMLElement>(`[data-component-id="${CSS.escape(r.id)}"]`)
          : document.getElementById(r.id);
      if (!el) continue;
      el.setAttribute('data-pinmap', r.role);
      if (r.kind === 'board') el.setAttribute('data-pinmap-board', '');
      if (r.color) el.style.setProperty('--pinmap-c', r.color);
      els.push(el);
    }
    return () => {
      for (const el of els) {
        el.removeAttribute('data-pinmap');
        el.removeAttribute('data-pinmap-board');
        el.style.removeProperty('--pinmap-c');
      }
    };
  }, [ringsKey]);

  if (!target || (!board && !component)) return null;
  const showUnwired = unwiredOpenFor === target.id;

  const isBoard = Boolean(board);
  const title = board ? boardDisplayName(board) : componentLabel(component!).title;
  const subtitle = board ? board.boardKind : `${componentLabel(component!).name} · ${component!.id}`;
  const live = isBoard && Boolean(board!.running);

  const renderRow = (r: PinRow, i: number) => {
    const active = hoverPin === r.pin;
    return (
      <li
        key={r.pin}
        className={'pin-map__row' + (active ? ' pin-map__row--active' : '')}
        style={{ '--i': i } as React.CSSProperties}
        onMouseEnter={() => setHoverPin(r.pin)}
        onMouseLeave={() => setHoverPin(null)}
        onFocus={() => setHoverPin(r.pin)}
        onBlur={() => setHoverPin(null)}
        tabIndex={0}
      >
        <div className="pin-map__pin">
          <span className="pin-map__pin-name">{r.label}</span>
          {r.sub && <span className="pin-map__pin-sub">{r.sub}</span>}
        </div>
        {r.links.length === 0 ? (
          <div className="pin-map__links">
            <RoleChip role={r.role} />
            <span className="pin-map__nc">not connected</span>
          </div>
        ) : (
          <ul className="pin-map__links">
            {r.links.map((l) => (
              <li key={l.wire.id} className="pin-map__link">
                {isBoard && <RoleChip role={r.role} />}
                {!isBoard && r.role.kind !== 'none' && <RoleChip role={r.role} />}
                <span className="pin-map__arrow" aria-hidden="true">
                  {flowArrow(r.role, l.peerRole, isBoard)}
                </span>
                <span className="pin-map__swatch" style={{ background: l.wire.color }} />
                <button
                  type="button"
                  className="pin-map__peer"
                  disabled={!l.peer}
                  title={l.peer ? `Show ${l.peerLabel}'s pins` : undefined}
                  onClick={() => l.peer && onNavigate(l.peer)}
                >
                  <span className="pin-map__peer-part">{l.peerLabel}</span>
                  <span className="pin-map__peer-pin">{l.peerPin}</span>
                </button>
                {!isBoard && l.peerRole && <RoleChip role={l.peerRole} />}
              </li>
            ))}
          </ul>
        )}
      </li>
    );
  };

  // Parts group by the far end's role; boards by their own pin's.
  const sectionOf = (r: PinRow): RoleKind => (isBoard ? r.role.kind : (r.links[0]?.peerRole ?? r.role).kind);
  let rowIndex = 0;
  const staleRoles = wired.some((r) => {
    const role = isBoard ? r.role : r.links[0]?.peerRole;
    return role && (role.kind === 'in' || role.kind === 'out') && role.live === false;
  });

  return (
    <aside
      className="pin-map"
      data-canvas-overlay
      aria-label={`Pin map for ${title}`}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <header className="pin-map__head">
        <div className="pin-map__head-text">
          <span className="pin-map__kind">{isBoard ? 'Board' : 'Part'} · pin map</span>
          <h2 className="pin-map__title">{title}</h2>
          <span className="pin-map__subtitle">{subtitle}</span>
        </div>
        <button type="button" className="pin-map__close" onClick={close} aria-label="Close pin map">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      <div className="pin-map__stats">
        <span>
          <b>{wired.length}</b> wired
        </span>
        <span>
          <b>{rows.length}</b> pins
        </span>
        {live ? (
          <span className="pin-map__live">live</span>
        ) : staleRoles ? (
          <span className="pin-map__stale" title="Directions from the last run">
            last run
          </span>
        ) : isBoard ? (
          <span className="pin-map__stale" title="Run the sketch to see pin directions">
            run for IN/OUT
          </span>
        ) : null}
      </div>

      <div className="pin-map__body">
        {wired.length === 0 && <p className="pin-map__empty">No wires on this part yet.</p>}
        {SECTIONS.map((s) => {
          const list = wired.filter((r) => s.kinds.includes(sectionOf(r)));
          if (list.length === 0) return null;
          return (
            <section key={s.id} className="pin-map__section">
              <h3 className="pin-map__section-title">
                {isBoard || s.id === 'power' || s.id === 'other' ? s.title : s.id === 'in' ? 'To board inputs' : 'From board outputs'}
                <span className="pin-map__count">{list.length}</span>
              </h3>
              <ul className="pin-map__rows">{list.map((r) => renderRow(r, rowIndex++))}</ul>
            </section>
          );
        })}

        {unwired.length > 0 && (
          <section className="pin-map__section pin-map__section--unwired">
            <button
              type="button"
              className="pin-map__toggle"
              aria-expanded={showUnwired}
              onClick={() => setUnwiredOpenFor(showUnwired ? null : target.id)}
            >
              <span className="pin-map__caret" aria-hidden="true" />
              Not connected
              <span className="pin-map__count">{unwired.length}</span>
            </button>
            {showUnwired && <ul className="pin-map__rows">{unwired.map((r) => renderRow(r, rowIndex++))}</ul>}
          </section>
        )}
      </div>
    </aside>
  );
}
