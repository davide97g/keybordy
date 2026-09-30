/**
 * Pin map: which part the right-hand pin map panel is showing, and which of
 * its pins the pointer is on. The panel lists every pin with where its wire
 * goes; the wire layer and the parts read this store to light that part's
 * wires and the parts at their far ends.
 *
 * Kept apart from the canvas's edit selection on purpose: the selection is
 * dropped when a run starts (the canvas becomes interact-only), but the pin
 * map stays open so it can show the live pin directions and levels.
 */

import { create } from 'zustand';

export interface PinMapTarget {
  kind: 'component' | 'board';
  id: string;
}

interface PinMapState {
  target: PinMapTarget | null;
  /** The pin row under the pointer: its wires are drawn on top, the rest dim. */
  hoverPin: string | null;
  open: (target: PinMapTarget) => void;
  close: () => void;
  setHoverPin: (pin: string | null) => void;
}

export const usePinMapStore = create<PinMapState>((set) => ({
  target: null,
  hoverPin: null,
  open: (target) => set({ target, hoverPin: null }),
  close: () => set({ target: null, hoverPin: null }),
  setHoverPin: (hoverPin) => set({ hoverPin }),
}));
