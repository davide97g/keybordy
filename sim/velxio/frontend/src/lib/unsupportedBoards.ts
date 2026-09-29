/**
 * Boards this build can draw but not run.
 *
 * STM32 (libqemu-arm) and the QEMU Raspberry Pi family (Zero/1/2/3/4/5)
 * are emulated only by velxio.dev's private backend, which this fork does
 * not ship. They are kept out of the board picker, the new-project dialog
 * and the example gallery so nothing offers a board that cannot start.
 * The Pico boards are browser emulation and stay.
 */
import { isPiBoardKind, isStm32BoardKind, type BoardKind } from '../types/board';

export function isUnsupportedBoardKind(kind: BoardKind | string): boolean {
  return isStm32BoardKind(kind) || isPiBoardKind(kind);
}
