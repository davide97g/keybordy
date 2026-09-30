/**
 * The pin map's role for a board pin: power and ground from the pin name,
 * and a GPIO's direction, pull and level from the board's PinManager, kept
 * after the run stops so the map can still say which pins were inputs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PinManager } from '../simulation/PinManager';

vi.mock('../simulation/spice/electricalResolveHook', () => ({
  requestElectricalResolve: vi.fn(),
}));

let pm: PinManager | undefined;
vi.mock('../store/useSimulatorStore', () => ({
  getBoardPinManager: () => pm,
}));

const { boardPinRole, boardPinLabel, partPinRole, clearLastSeenPins } = await import(
  '../utils/pinMapRoles'
);

describe('pin map roles', () => {
  beforeEach(() => {
    pm = new PinManager();
    clearLastSeenPins();
  });

  it('names supply and ground pins without a run', () => {
    expect(boardPinRole('esp', 'esp32', 'GND', false)).toMatchObject({ kind: 'gnd' });
    expect(boardPinRole('esp', 'esp32', '3V3', false)).toMatchObject({ kind: 'pwr', text: '3V3' });
    expect(boardPinRole('esp', 'esp32', 'VIN', false)).toMatchObject({ kind: 'pwr' });
  });

  it('reads a GPIO as plain GPIO before the sketch configures it', () => {
    expect(boardPinRole('esp', 'esp32', '32', false)).toEqual({ kind: 'gpio', text: 'GPIO' });
  });

  it('shows an INPUT_PULLUP key pin and a GPIO ground from the running pads', () => {
    pm!.setPinDirection(32, 0);
    pm!.setPinPull(32, 1);
    pm!.setPinState(32, true);
    pm!.setPinDirection(25, 1);
    pm!.setPinState(25, false, 'mcu');

    expect(boardPinRole('esp', 'esp32', '32', true)).toEqual({
      kind: 'in',
      text: 'IN',
      detail: 'PULLUP · HIGH',
      live: true,
    });
    expect(boardPinRole('esp', 'esp32', '25', true)).toEqual({
      kind: 'out',
      text: 'OUT',
      detail: 'LOW',
      live: true,
    });
  });

  it('keeps the last run once the pads are cleared', () => {
    pm!.setPinDirection(32, 0);
    pm!.setPinPull(32, 1);
    boardPinRole('esp', 'esp32', '32', true);
    pm!.resetPinStates();

    expect(boardPinRole('esp', 'esp32', '32', false)).toMatchObject({ kind: 'in', live: false });
  });

  it('labels numeric pins the way the DevKit silk does', () => {
    expect(boardPinLabel('32')).toBe('D32');
    expect(boardPinLabel('GND2')).toBe('GND2');
  });

  it('takes a part pin role from its power signal', () => {
    expect(partPinRole({ name: 'GND', signals: [{ type: 'power', signal: 'GND' }] })).toMatchObject({
      kind: 'gnd',
    });
    expect(partPinRole({ name: '1.l' })).toMatchObject({ kind: 'none' });
  });
});
