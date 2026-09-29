// Loads firmware/keys8 into Velxio every time /editor opens.
// Velxio keeps no workspace across reloads for anonymous users, so the repo
// stays the source of truth: edit keys8.ino or diagram.json, then reload.
// Add ?blank to the URL to skip it.
(function () {
  if (!location.pathname.startsWith("/editor")) return;
  if (new URLSearchParams(location.search).has("blank")) return;

  const BASE = "/keybordy/keys8/";

  // CRC-32 and a store-only zip writer: enough for Velxio's Wokwi importer.
  const CRC = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  function crc32(bytes) {
    let c = 0xffffffff;
    for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function zip(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true);
      local.setUint32(14, crc, true); local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true); local.setUint16(26, name.length, true);
      parts.push(local.buffer, name, data);
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
      cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true); cd.setUint16(28, name.length, true);
      cd.setUint32(42, offset, true);
      central.push(cd.buffer, name);
      offset += 30 + name.length + data.length;
    }
    const size = central.reduce((n, p) => n + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true); end.setUint32(12, size, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
  }

  // firmware/keys8/diagram.json is a plain Wokwi diagram. Velxio calls its
  // 30-pin DevKit "board-velxio-esp32" and has no $serialMonitor part.
  function forVelxio(diagram) {
    for (const p of diagram.parts) if (p.type === "wokwi-esp32-devkit-v1") p.type = "board-velxio-esp32";
    diagram.connections = diagram.connections.filter(c => !(c[0] + c[1]).includes("$serialMonitor"));
    return diagram;
  }

  function waitFor(find, ms) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function tick() {
        const el = find();
        if (el) return resolve(el);
        if (Date.now() - t0 > ms) return reject(new Error("timed out"));
        setTimeout(tick, 150);
      })();
    });
  }

  async function run() {
    const [diagram, sketch] = await Promise.all([
      fetch(BASE + "diagram.json", { cache: "no-store" }).then(r => r.json()),
      fetch(BASE + "keys8.ino", { cache: "no-store" }).then(r => r.text()),
    ]);
    const blob = zip([
      { name: "diagram.json", text: JSON.stringify(forVelxio(diagram), null, 2) },
      { name: "keys8.ino", text: sketch },
    ]);

    const input = await waitFor(() => document.querySelector('input[type=file][accept*=".zip"]'), 20000);

    // The "Start a new project" picker can open a moment after the editor,
    // so keep closing it for a few seconds.
    const closePicker = () => {
      const picker = [...document.querySelectorAll("[role=dialog]")]
        .find(d => d.textContent.includes("Start a new project"));
      [...(picker?.querySelectorAll("button") ?? [])].find(b => b.textContent.trim() === "Cancel")?.click();
    };
    const watch = new MutationObserver(closePicker);
    watch.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => watch.disconnect(), 8000);
    closePicker();

    const dt = new DataTransfer();
    dt.items.add(new File([blob], "keys8.zip", { type: "application/zip" }));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    console.log("[keybordy] loaded firmware/keys8 into Velxio");
  }

  run().catch(err => console.warn("[keybordy] autoload failed:", err));
})();
