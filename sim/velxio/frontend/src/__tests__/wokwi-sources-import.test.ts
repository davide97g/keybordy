/**
 * A plain Wokwi diagram (as wokwi.com and the Wokwi VS Code extension write
 * it) imports from its files alone: the esp32-devkit-v1 part becomes a
 * running ESP32, its `D<n>` / `GND.<n>` pins take the Velxio element's
 * names, and the virtual `$serialMonitor` wires are dropped.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { importFromWokwiSources, registerDefaultWokwiBoardMappings } from '../utils/wokwiZip';

const diagram = {
  version: 1,
  parts: [
    { type: 'wokwi-esp32-devkit-v1', id: 'esp', top: 0, left: 0, attrs: {} },
    { type: 'wokwi-pushbutton', id: 'k1', top: -40, left: 220, attrs: { color: 'blue' } },
    { type: 'wokwi-pushbutton', id: 'k2', top: -40, left: 330, attrs: { color: 'blue' } },
  ],
  connections: [
    ['esp:TX0', '$serialMonitor:RX', '', []],
    ['esp:RX0', '$serialMonitor:TX', '', []],
    ['k1:1.l', 'esp:D13', 'green', []],
    ['k1:2.l', 'esp:GND.1', 'black', []],
    ['k2:2.l', 'esp:GND.2', 'black', []],
  ],
};

const sources = [
  { name: 'diagram.json', content: JSON.stringify(diagram) },
  { name: 'keys8.ino', content: 'void setup() {}\nvoid loop() {}\n' },
  { name: 'wokwi.toml', content: '[wokwi]\n' },
];

describe('importFromWokwiSources', () => {
  beforeAll(() => registerDefaultWokwiBoardMappings());

  it('maps the devkit-v1 part to the esp32 board', () => {
    const r = importFromWokwiSources(sources);
    expect(r.boardType).toBe('esp32');
    expect(r.components.map((c) => c.id)).toEqual(['k1', 'k2']);
    expect(r.warnings).toEqual([]);
  });

  it('drops $serialMonitor wires and renames the board pins', () => {
    const r = importFromWokwiSources(sources);
    const boardPins = r.wires.flatMap((w) =>
      [w.start, w.end].filter((e) => e.componentId === 'esp32').map((e) => e.pinName),
    );
    expect(r.wires).toHaveLength(3);
    expect(boardPins).toEqual(['13', 'GND', 'GND2']);
  });

  it('keeps only the sketch sources as editor files', () => {
    expect(importFromWokwiSources(sources).files.map((f) => f.name)).toEqual(['keys8.ino']);
  });
});
