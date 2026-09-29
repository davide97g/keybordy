import { useEffect, useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { Html, Line, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { nets, segments, type DeviceId, type NetId, type Vec3 } from "./data";

const colorOf = (id: NetId) => nets.find((net) => net.id === id)?.color ?? "#333";

function Jumper({ a, b, color, hot, dim }: { a: Vec3; b: Vec3; color: string; hot: boolean; dim: boolean }) {
  const geometry = useMemo(() => {
    const start = new THREE.Vector3(...a);
    const end = new THREE.Vector3(...b);
    const mid = start.clone().lerp(end, 0.5);
    mid.y += 0.7 + Math.min(start.distanceTo(end) * 0.08, 0.45);
    const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
    return new THREE.TubeGeometry(curve, 36, hot ? 0.04 : 0.022, 8, false);
  }, [a, b, hot]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  const opacity = dim ? 0.15 : 1;

  return (
    <group>
      <mesh geometry={geometry}>
        <meshStandardMaterial
          color={color}
          roughness={0.45}
          metalness={0.08}
          emissive={color}
          emissiveIntensity={hot ? 0.45 : 0}
          transparent
          opacity={opacity}
        />
      </mesh>
      {[a, b].map((point, index) => (
        <mesh key={index} position={point}>
          <sphereGeometry args={[hot ? 0.07 : 0.045, 12, 12]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={hot ? 0.4 : 0} transparent opacity={opacity} />
        </mesh>
      ))}
    </group>
  );
}

function PinCallout({
  pin,
  label,
  name,
  hint,
  color,
}: {
  pin: Vec3;
  label: Vec3;
  name: string;
  hint: string;
  color: string;
}) {
  return (
    <group>
      <Line points={[pin, label]} color="#172033" lineWidth={1.5} />
      <mesh position={pin}>
        <sphereGeometry args={[0.055, 12, 12]} />
        <meshStandardMaterial color={color} />
      </mesh>
      <Html position={label} center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
        <span className="pin-tag">
          <i style={{ background: color }} />
          <b>{name}</b>
          {hint ? <em>{hint}</em> : null}
        </span>
      </Html>
    </group>
  );
}

function Board({ hot, onPick }: { hot: boolean; onPick: () => void }) {
  return (
    <group
      onClick={(event) => {
        event.stopPropagation();
        onPick();
      }}
    >
      <mesh position={[0, 0.06, 0]} receiveShadow>
        <boxGeometry args={[3.1, 0.12, 5.5]} />
        <meshStandardMaterial color="#14382c" roughness={0.72} emissive={hot ? "#d7e6d4" : "#000"} emissiveIntensity={hot ? 0.22 : 0} />
      </mesh>
      <mesh position={[0, 0.16, -0.15]}>
        <boxGeometry args={[1.55, 0.18, 2.15]} />
        <meshStandardMaterial color="#c5c8cc" metalness={0.55} roughness={0.35} />
      </mesh>
      <mesh position={[0, 0.08, 2.55]}>
        <boxGeometry args={[0.7, 0.22, 0.45]} />
        <meshStandardMaterial color="#b9bcc0" metalness={0.6} roughness={0.3} />
      </mesh>
      <mesh position={[0, 0.13, -2.35]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[1.2, 0.55]} />
        <meshStandardMaterial color="#c6a15a" metalness={0.4} roughness={0.45} />
      </mesh>
      <Html position={[0, 0.45, 2.05]} center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
        <span className={hot ? "device-name on" : "device-name"}>ESP32</span>
      </Html>
      <PinCallout pin={[-1.55, 0.32, -2.15]} label={[-2.55, 0.85, -2.45]} name="3V3" hint="power" color="#d12b22" />
      <PinCallout pin={[-1.55, 0.32, -0.15]} label={[-2.55, 0.85, -0.85]} name="25" hint="CLK" color="#1f9d4e" />
      <PinCallout pin={[-1.55, 0.32, 0.25]} label={[-2.95, 0.85, 0.2]} name="26" hint="DT" color="#6d45c4" />
      <PinCallout pin={[-1.55, 0.32, 0.65]} label={[-2.55, 0.85, 1.15]} name="27" hint="SW" color="#e07a1a" />
      <PinCallout pin={[-1.55, 0.32, 1.45]} label={[-2.55, 0.85, 1.95]} name="GND" hint="rotary" color="#1c1c1c" />
      <PinCallout pin={[1.55, 0.32, -2.15]} label={[2.55, 0.85, -2.45]} name="GND" hint="oled" color="#1c1c1c" />
      <PinCallout pin={[1.55, 0.32, -1.15]} label={[2.55, 0.85, -1.2]} name="22" hint="SCL" color="#e2b31c" />
      <PinCallout pin={[1.55, 0.32, -0.15]} label={[2.55, 0.85, -0.15]} name="21" hint="SDA" color="#2c6bed" />
    </group>
  );
}

function Oled({ hot, onPick }: { hot: boolean; onPick: () => void }) {
  return (
    <group
      position={[-4.45, 0, -0.4]}
      onClick={(event) => {
        event.stopPropagation();
        onPick();
      }}
    >
      <mesh position={[0, 0.05, 0]}>
        <boxGeometry args={[2.3, 0.1, 2.5]} />
        <meshStandardMaterial color={hot ? "#2f6ec4" : "#1d4f96"} roughness={0.55} />
      </mesh>
      <mesh position={[0, 0.12, 0.15]}>
        <boxGeometry args={[1.7, 0.04, 1.35]} />
        <meshStandardMaterial color="#0d1220" roughness={0.25} metalness={0.2} />
      </mesh>
      <mesh position={[1.05, 0.12, -0.15]}>
        <boxGeometry args={[0.18, 0.08, 1.15]} />
        <meshStandardMaterial color="#e2b31c" />
      </mesh>
      <Html position={[0, 0.4, 1.15]} center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
        <span className={hot ? "device-name on" : "device-name"}>OLED</span>
      </Html>
      <PinCallout pin={[1.15, 0.2, -0.7]} label={[-0.85, 0.45, -0.95]} name="GND" hint="" color="#1c1c1c" />
      <PinCallout pin={[1.15, 0.2, -0.3]} label={[-0.85, 0.45, -0.35]} name="VCC" hint="" color="#d12b22" />
      <PinCallout pin={[1.15, 0.2, 0.1]} label={[-0.85, 0.45, 0.25]} name="SCL" hint="" color="#e2b31c" />
      <PinCallout pin={[1.15, 0.2, 0.5]} label={[-0.85, 0.45, 0.85]} name="SDA" hint="" color="#2c6bed" />
    </group>
  );
}

function Rotary({ hot, onPick }: { hot: boolean; onPick: () => void }) {
  return (
    <group
      position={[4.45, 0, 0.2]}
      onClick={(event) => {
        event.stopPropagation();
        onPick();
      }}
    >
      <mesh position={[0, 0.05, 0]}>
        <boxGeometry args={[2.1, 0.1, 2.7]} />
        <meshStandardMaterial color={hot ? "#3a414a" : "#1a1d21"} roughness={0.7} />
      </mesh>
      <mesh position={[-0.15, 0.22, -0.15]}>
        <boxGeometry args={[0.7, 0.28, 0.7]} />
        <meshStandardMaterial color="#9aa0a6" metalness={0.7} roughness={0.28} />
      </mesh>
      <mesh position={[-0.15, 0.55, -0.15]}>
        <cylinderGeometry args={[0.12, 0.12, 0.45, 16]} />
        <meshStandardMaterial color="#d5d8dc" metalness={0.8} roughness={0.2} />
      </mesh>
      <mesh position={[-0.15, 0.85, -0.15]}>
        <cylinderGeometry args={[0.22, 0.22, 0.28, 20]} />
        <meshStandardMaterial color="#cfd3d8" metalness={0.65} roughness={0.35} />
      </mesh>
      <Html position={[0.2, 0.45, 1.2]} center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
        <span className={hot ? "device-name on" : "device-name"}>ROTARY</span>
      </Html>
      <PinCallout pin={[-1.0, 0.22, -0.8]} label={[0.72, 0.5, -0.95]} name="CLK" hint="" color="#1f9d4e" />
      <PinCallout pin={[-1.0, 0.22, -0.4]} label={[0.72, 0.5, -0.4]} name="DT" hint="" color="#6d45c4" />
      <PinCallout pin={[-1.0, 0.22, 0]} label={[0.72, 0.5, 0.15]} name="SW" hint="" color="#e07a1a" />
      <PinCallout pin={[-1.0, 0.22, 0.4]} label={[0.72, 0.5, 0.65]} name="+" hint="" color="#d12b22" />
      <PinCallout pin={[-1.0, 0.22, 0.8]} label={[0.72, 0.5, 1.15]} name="GND" hint="" color="#1c1c1c" />
    </group>
  );
}

function Rail() {
  return (
    <group position={[-2.55, 0.08, -2.15]}>
      <mesh>
        <boxGeometry args={[0.9, 0.08, 0.28]} />
        <meshStandardMaterial color="#f4f1ea" />
      </mesh>
      <mesh position={[0, 0.05, 0]}>
        <boxGeometry args={[0.7, 0.03, 0.08]} />
        <meshStandardMaterial color="#d12b22" />
      </mesh>
    </group>
  );
}

function pick(current: DeviceId | null, id: DeviceId, onDevice: (id: DeviceId | null) => void) {
  onDevice(current === id ? null : id);
}

export default function BenchScene({
  selected,
  device,
  onDevice,
}: {
  selected: NetId | null;
  device: DeviceId | null;
  onDevice: (id: DeviceId | null) => void;
}) {
  return (
    <Canvas
      camera={{ position: [0, 12.4, 11.2], fov: 34 }}
      dpr={[1, 2]}
      onPointerMissed={() => onDevice(null)}
    >
      <color attach="background" args={["#d5decc"]} />
      <hemisphereLight args={["#f7f8f2", "#6e845c", 0.95]} />
      <directionalLight position={[5, 8, 4]} intensity={1.15} />
      <gridHelper args={[18, 18, "#8ea384", "#c3d0b6"]} position={[0, 0, 0]} />
      <Board hot={device === "esp"} onPick={() => pick(device, "esp", onDevice)} />
      <Oled hot={device === "oled"} onPick={() => pick(device, "oled", onDevice)} />
      <Rotary hot={device === "rotary"} onPick={() => pick(device, "rotary", onDevice)} />
      <Rail />
      {segments.map((segment) => {
        const hot = selected === segment.net;
        return (
          <Jumper
            key={segment.id}
            a={segment.a}
            b={segment.b}
            color={colorOf(segment.net)}
            hot={hot}
            dim={selected !== null && !hot}
          />
        );
      })}
      <OrbitControls enablePan target={[0, 0.2, 0]} maxPolarAngle={Math.PI / 2.05} />
    </Canvas>
  );
}
