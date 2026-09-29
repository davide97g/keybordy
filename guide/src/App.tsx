import { lazy, Suspense, useState } from "react";
import { devices, nets, session, type DeviceId, type NetId } from "./data";
import { WiringFlow } from "./WiringFlow";

const BenchScene = lazy(() => import("./BenchScene"));

export function App() {
  const [net, setNet] = useState<NetId | null>(null);
  const [device, setDevice] = useState<DeviceId | null>(null);
  const active = nets.find((item) => item.id === net);
  const picked = devices.find((item) => item.id === device);

  return (
    <div className="page">
      <header className="mast">
        <p className="eyebrow">Keybordy · 27 Sep 2026</p>
        <h1>The count on the glass</h1>
        <p className="lede">
          ESP32 DevKit, SSD1306 OLED, and a five-pin rotary. This is the wiring
          that already runs: turn the knob and the number moves, press it and
          the number returns to 0.
        </p>
      </header>

      <section className="log" aria-label="What was done">
        <h2>Done this session</h2>
        <ol>
          {session.map((item) => (
            <li key={item.title}>
              <strong>{item.title}</strong>
              <span>{item.body}</span>
            </li>
          ))}
        </ol>
      </section>

      <div className="stage">
        <section className="panel" aria-label="3D bench">
          <div className="panel-head">
            <h2>Bench</h2>
            <p>Click a board for its pins. Drag to turn. Scroll to zoom.</p>
          </div>
          <div className="viewport">
            <Suspense fallback={<p className="fallback">Loading the bench…</p>}>
              <BenchScene selected={net} device={device} onDevice={setDevice} />
            </Suspense>
          </div>
          {picked ? (
            <aside className="device-card" aria-label={`${picked.title} pins`}>
              <div className="device-card-head">
                <h3>{picked.title}</h3>
                <button type="button" onClick={() => setDevice(null)}>
                  Close
                </button>
              </div>
              <p>{picked.summary}</p>
              <ul>
                {picked.pins.map((pin) => {
                  const color = nets.find((item) => item.id === pin.net)?.color ?? "#172033";
                  const on = net === pin.net;
                  return (
                    <li key={`${pin.name}-${pin.net}`}>
                      <button
                        type="button"
                        className={on ? "pin-row on" : "pin-row"}
                        aria-pressed={on}
                        onClick={() => setNet(on ? null : pin.net)}
                      >
                        <i style={{ background: color }} aria-hidden="true" />
                        <b>{pin.name}</b>
                        <span>{pin.meaning}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </aside>
          ) : null}
        </section>

        <section className="panel wires" aria-label="Jumper list">
          <div className="panel-head">
            <h2>Jumpers</h2>
            <p>Match the silkscreen numbers. Color is only so the two diagrams agree.</p>
          </div>
          <ul>
            {nets.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={net === item.id ? "wire on" : "wire"}
                  aria-pressed={net === item.id}
                  onClick={() => setNet(net === item.id ? null : item.id)}
                >
                  <i style={{ background: item.color }} aria-hidden="true" />
                  <span className="wire-name">{item.name}</span>
                  <span className="wire-path">
                    {item.from}
                    <span className="wire-to"> to </span>
                    {item.to}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {active ? <p className="note">{active.note}</p> : <p className="note">Select a jumper to read where it lands.</p>}
        </section>
      </div>

      <section className="panel flow-panel" aria-label="Wiring diagram">
        <div className="panel-head">
          <h2>Wiring map</h2>
          <p>
            OLED header, left to right on the glass: GND, VCC, SCL, SDA. Rotary,
            knob up and pins toward you, left to right: CLK, DT, SW, +, GND.
          </p>
        </div>
        <div className="flow">
          <WiringFlow
            selected={net}
            device={device}
            onSelect={setNet}
            onDevice={setDevice}
          />
        </div>
      </section>

      <footer>
        <p>
          Leave empty: VIN, and GPIO 0, 1, 2, 3, 12, 15. Sketch{" "}
          <code>firmware/rotary_oled/rotary_oled.ino</code>. Written record in{" "}
          <code>docs/session.md</code>.
        </p>
      </footer>
    </div>
  );
}
