// The 2.42" SSD1309: a 128x64 1-bit framebuffer drawn like the firmware would (thresholded), then
// blown up into a texture with every pixel a separate lit square, so close-ups read as a real panel.
import * as THREE from 'three';

export type OledState =
  | { mode: 'off' }
  | { mode: 'boot'; p: number }                       // 0..1: scanline wipe then the wordmark
  | { mode: 'logo' }
  | { mode: 'key'; label: string; detail: string }
  | { mode: 'knob'; name: string; value: number }
  | { mode: 'listen'; t: number; transcript?: string };

const PX = 12; // texture px per panel px
export class Oled {
  fb = document.createElement('canvas');
  big = document.createElement('canvas');
  tex: THREE.CanvasTexture;
  private g: CanvasRenderingContext2D;
  private bg: CanvasRenderingContext2D;
  private last = '';

  constructor() {
    this.fb.width = 128; this.fb.height = 64;
    this.big.width = 128 * PX; this.big.height = 64 * PX;
    this.g = this.fb.getContext('2d', { willReadFrequently: true })!;
    this.bg = this.big.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.big);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 8;
    this.tex.generateMipmaps = true;
    this.tex.minFilter = THREE.LinearMipmapLinearFilter;
  }

  draw(s: OledState) {
    const key = JSON.stringify(s, (_k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v));
    if (key === this.last) return;
    this.last = key;
    const g = this.g;
    g.fillStyle = '#000'; g.fillRect(0, 0, 128, 64);
    g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.textBaseline = 'top'; g.textAlign = 'center';
    const center = (text: string, y: number, f: string) => { g.font = f; g.fillText(text, 64, y); };
    const bar = () => {
      g.font = '600 8px "Martian Mono"'; g.textAlign = 'left'; g.fillText('L1', 1, 0); g.fillText('BLE', 20, 0);
      g.textAlign = 'right'; g.fillText('82%', 110, 0);
      g.strokeRect(112.5, 1.5, 13, 6); g.fillRect(126, 3, 1.5, 3); g.fillRect(114, 3, 8, 3);
      g.fillRect(0, 10, 128, 1); g.textAlign = 'center';
    };
    switch (s.mode) {
      case 'off': break;
      case 'boot': {
        const scan = Math.min(1, s.p / 0.45) * 64;
        if (s.p < 0.45) for (let y = 0; y < scan; y += 2) g.fillRect(0, y, 128, 1);
        else {
          const k = Math.min(1, (s.p - 0.45) / 0.4);
          center('keybordy', 22, '900 19px "Anybody"');
          g.fillStyle = '#000'; g.fillRect(4 + 120 * k, 18, 128, 28); g.fillStyle = '#fff';
          if (s.p > 0.85) { g.font = '400 7px "Martian Mono"'; g.fillText('MP · ready', 64, 50); }
        }
        break;
      }
      case 'logo':
        bar(); center('keybordy', 19, '900 19px "Anybody"');
        g.font = '400 8px "Martian Mono"'; g.fillText('VOL 42  SCRL  LIGHT 70', 64, 51); break;
      case 'key':
        bar(); center(s.label, 16, `900 ${s.label.length > 6 ? 18 : 22}px "Anybody"`);
        center(s.detail, 46, '400 8px "Martian Mono"'); break;
      case 'knob': {
        bar(); g.font = '700 9px "Martian Mono"'; g.textAlign = 'left'; g.fillText(s.name, 2, 15);
        center(String(Math.round(s.value)), 25, '900 22px "Anybody"');
        g.strokeRect(2.5, 53.5, 123, 8); g.fillRect(4, 55, Math.round(120 * s.value / 100), 5); break;
      }
      case 'listen':
        bar();
        if (s.transcript) { center('“' + s.transcript + '”', 18, '400 9px "Martian Mono"'); center('› Notes', 34, '800 16px "Anybody"'); break; }
        center('LISTENING', 14, '700 9px "Martian Mono"');
        for (let i = 0; i < 30; i++) {
          const h = 2 + Math.abs(Math.sin(s.t * 7.1 + i * 0.7) * Math.sin(s.t * 2.7 + i * 1.3)) * 22;
          g.fillRect(4 + i * 4, 42 - h / 2, 2, h);
        }
        break;
    }
    // 1-bit threshold like the real panel, then a lit square per pixel with a dark gap
    const d = g.getImageData(0, 0, 128, 64).data;
    const b = this.bg;
    b.fillStyle = '#000'; b.fillRect(0, 0, this.big.width, this.big.height);
    b.fillStyle = '#fff';
    for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) {
      if (d[(y * 128 + x) * 4]! > 118) b.fillRect(x * PX + 1, y * PX + 1, PX - 2, PX - 2);
    }
    this.tex.needsUpdate = true;
  }
}
