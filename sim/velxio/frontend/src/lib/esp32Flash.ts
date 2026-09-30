/**
 * Flash a simulator-compiled ESP32 image to a real board over Web Serial.
 *
 * The simulator's compile returns one merged image (bootloader at 0x1000,
 * partition table at 0x8000, app at 0x10000, trailing 0xFF trimmed). The
 * same image boots on the bench board, so the browser can flash it with
 * esptool-js and no host tooling.
 *
 * Writing the merged image as-is would also blank the NVS partition, which
 * can hold Wi-Fi credentials from other firmware. `planFlashRegions` writes
 * everything in the image except NVS, so otadata still comes out blank the
 * way the image says, and NVS is left alone.
 */

import { ESPLoader, Transport, type IEspLoaderTerminal } from 'esptool-js';

import { md5Hex } from './md5';

export interface FlashRegion {
  address: number;
  data: Uint8Array;
}

const SECTOR = 0x1000;
const PARTITION_TABLE_OFFSET = 0x8000;
const PARTITION_MAGIC = 0x50aa;
/** Data partition subtypes left untouched: nvs, nvs_keys. */
const PRESERVED_DATA_SUBTYPES = new Set([0x02, 0x04]);

interface Partition {
  type: number;
  subtype: number;
  offset: number;
  size: number;
  name: string;
}

export function readPartitionTable(image: Uint8Array): Partition[] {
  const out: Partition[] = [];
  if (image.length < PARTITION_TABLE_OFFSET + 32) return out;
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  for (let at = PARTITION_TABLE_OFFSET; at + 32 <= image.length; at += 32) {
    if (view.getUint16(at, true) !== PARTITION_MAGIC) break;
    const nameBytes = image.subarray(at + 12, at + 28);
    const nul = nameBytes.indexOf(0);
    out.push({
      type: image[at + 2],
      subtype: image[at + 3],
      offset: view.getUint32(at + 4, true),
      size: view.getUint32(at + 8, true),
      name: new TextDecoder().decode(nul >= 0 ? nameBytes.subarray(0, nul) : nameBytes),
    });
  }
  return out;
}

/**
 * The regions to write: from the first non-blank sector to the end of the
 * image, minus the preserved data partitions.
 */
export function planFlashRegions(image: Uint8Array): FlashRegion[] {
  let start = 0;
  while (start < image.length && image.subarray(start, start + SECTOR).every((b) => b === 0xff)) {
    start += SECTOR;
  }
  if (start >= image.length) return [];

  const holes = readPartitionTable(image)
    .filter((p) => p.type === 0x01 && PRESERVED_DATA_SUBTYPES.has(p.subtype))
    .map((p) => [p.offset, p.offset + p.size] as const)
    .sort((a, b) => a[0] - b[0]);

  const regions: FlashRegion[] = [];
  let cursor = start;
  for (const [from, to] of holes) {
    if (to <= cursor) continue;
    if (from > cursor) {
      const end = Math.min(from, image.length);
      if (end > cursor) regions.push({ address: cursor, data: image.slice(cursor, end) });
    }
    cursor = Math.max(cursor, to);
    if (cursor >= image.length) break;
  }
  if (cursor < image.length) regions.push({ address: cursor, data: image.slice(cursor) });
  return regions;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export type FlashPhase = 'connect' | 'write' | 'verify' | 'reset';

export interface FlashCallbacks {
  onPhase: (phase: FlashPhase) => void;
  /** 0..1 across all regions, by uncompressed bytes written. */
  onProgress: (fraction: number) => void;
  onLine: (line: string) => void;
}

export interface FlashResult {
  chip: string;
  bytes: number;
  elapsedMs: number;
}

/** Lines esptool-js logs that we never show: the MAC stays off screen. */
const HIDDEN_LINE = /^\s*MAC:/i;

/**
 * Connect through the ROM bootloader (DTR/RTS auto-reset), write the image,
 * verify each region's MD5 and hard-reset. The port must be closed; it is
 * closed again when this returns or throws.
 */
export async function flashEsp32(
  port: SerialPort,
  image: Uint8Array,
  cb: FlashCallbacks,
): Promise<FlashResult> {
  const t0 = performance.now();
  const regions = planFlashRegions(image);
  if (regions.length === 0) throw new Error('The firmware image is empty.');
  const total = regions.reduce((n, r) => n + r.data.length, 0);

  let partial = '';
  const emit = (text: string) => {
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() && !HIDDEN_LINE.test(line)) cb.onLine(line.trim());
    }
  };
  const terminal: IEspLoaderTerminal = {
    clean() {},
    writeLine(data: string) {
      emit(partial + data);
      partial = '';
    },
    write(data: string) {
      partial += data;
    },
  };

  const transport = new Transport(port, false);
  const loader = new ESPLoader({ transport, baudrate: 921600, terminal, debugLogging: false });
  try {
    cb.onPhase('connect');
    const chip = await loader.main();
    if (loader.chip.CHIP_NAME !== 'ESP32') {
      throw new Error(`Found ${chip}, but this image is built for a classic ESP32.`);
    }

    cb.onPhase('write');
    // Progress arrives per region as compressed bytes sent; map it onto the
    // region's share of the uncompressed total so the bar moves evenly.
    const before = regions.map((_, i) => regions.slice(0, i).reduce((n, r) => n + r.data.length, 0));
    let verifying = false;
    await loader.writeFlash({
      fileArray: regions.map((r) => ({ data: r.data, address: r.address })),
      flashMode: 'keep',
      flashFreq: 'keep',
      flashSize: 'keep',
      eraseAll: false,
      compress: true,
      reportProgress: (i, written, size) => {
        const share = size > 0 ? written / size : 1;
        cb.onProgress((before[i] + share * regions[i].data.length) / total);
        if (share >= 1 && !verifying && i === regions.length - 1) {
          verifying = true;
          cb.onPhase('verify');
        }
      },
      calculateMD5Hash: (data) => md5Hex(data),
    });

    cb.onPhase('reset');
    await loader.after('hard_reset');
    return { chip, bytes: total, elapsedMs: performance.now() - t0 };
  } finally {
    try {
      await transport.disconnect();
    } catch {
      // Already closed (the board went away): nothing left to release.
    }
  }
}
