/**
 * The new-project dialog lists only boards this build can run: no STM32 and
 * no QEMU Raspberry Pi (their emulators are not shipped).
 */
import { describe, it, expect } from 'vitest';
import { buildStarterSections } from '../components/editor/NewProjectDialog';
import { isUnsupportedBoardKind } from '../lib/unsupportedBoards';

describe('buildStarterSections', () => {
  it('lists the runnable board families in order', () => {
    expect(buildStarterSections().map((s) => s.title)).toEqual(['Arduino', 'ESP32', 'Raspberry Pi']);
  });

  it('offers no board without an emulator', () => {
    const kinds = buildStarterSections().flatMap((s) => s.entries.map((e) => e.kind));
    expect(kinds.filter(isUnsupportedBoardKind)).toEqual([]);
    expect(kinds).toContain('raspberry-pi-pico');
  });
});
