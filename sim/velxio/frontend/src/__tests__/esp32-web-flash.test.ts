import { describe, expect, it } from 'vitest';

import { md5Hex } from '../lib/md5';
import { planFlashRegions, readPartitionTable } from '../lib/esp32Flash';

const text = (s: string) => new TextEncoder().encode(s);

describe('md5Hex', () => {
  it('matches the RFC 1321 test suite', () => {
    expect(md5Hex(text(''))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex(text('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex(text('message digest'))).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    expect(md5Hex(text('1234567890'.repeat(8)))).toBe('57edf4a22be3c955ac49da2e2107b67a');
  });

  it('handles lengths around the 56-byte padding edge', () => {
    // 55, 56 and 64 bytes cross the one-block / two-block boundary.
    expect(md5Hex(new Uint8Array(55))).toBe('c9ea3314b91c9fd4e38f9432064fd1f2');
    expect(md5Hex(new Uint8Array(56))).toBe('e3c4dd21a9171fd39d208efa09bf7883');
    expect(md5Hex(new Uint8Array(64))).toBe('3b5d3c7d207e37dceeedd301e35e2e58');
  });
});

/** A merged image laid out like the simulator's ESP32 build of keys8. */
function keys8LikeImage(): Uint8Array {
  const img = new Uint8Array(0x49f30).fill(0xff);
  img.fill(0x11, 0x1000, 0x6000); // bootloader
  img.fill(0x33, 0x10000); // app
  const entries: [number, number, number, number, string][] = [
    [0x01, 0x02, 0x9000, 0x5000, 'nvs'],
    [0x01, 0x00, 0xe000, 0x2000, 'otadata'],
    [0x00, 0x10, 0x10000, 0x300000, 'app0'],
    [0x01, 0x82, 0x310000, 0xe0000, 'spiffs'],
  ];
  const view = new DataView(img.buffer);
  entries.forEach(([type, sub, off, size, name], i) => {
    const at = 0x8000 + i * 32;
    view.setUint16(at, 0x50aa, true);
    img[at + 2] = type;
    img[at + 3] = sub;
    view.setUint32(at + 4, off, true);
    view.setUint32(at + 8, size, true);
    img.fill(0, at + 12, at + 28);
    img.set(text(name), at + 12);
    view.setUint32(at + 28, 0, true);
  });
  return img;
}

describe('planFlashRegions', () => {
  it('reads the partition table', () => {
    const parts = readPartitionTable(keys8LikeImage());
    expect(parts.map((p) => p.name)).toEqual(['nvs', 'otadata', 'app0', 'spiffs']);
  });

  it('writes the image from the bootloader on, skipping NVS', () => {
    const img = keys8LikeImage();
    const regions = planFlashRegions(img);
    expect(regions.map((r) => [r.address, r.address + r.data.length])).toEqual([
      [0x1000, 0x9000],
      [0xe000, img.length],
    ]);
    // otadata is written blank, as the image has it.
    expect(regions[1].data.subarray(0, 0x2000).every((b) => b === 0xff)).toBe(true);
  });

  it('writes one region when there is no partition table', () => {
    const img = new Uint8Array(0x3000).fill(0xff);
    img.fill(1, 0x1000, 0x2800);
    const regions = planFlashRegions(img);
    expect(regions).toHaveLength(1);
    expect(regions[0].address).toBe(0x1000);
    expect(regions[0].data.length).toBe(0x2000);
  });

  it('returns nothing for a blank image', () => {
    expect(planFlashRegions(new Uint8Array(0x2000).fill(0xff))).toEqual([]);
  });
});
