import { useEffect, useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { nets, type DeviceId, type NetId } from "./data";

type Pin = { id: string; label: string; side: "left" | "right"; role: "source" | "target" };
type PartData = { title: string; kind: string; pins: Pin[] };

const colorOf = (id: NetId) => nets.find((net) => net.id === id)?.color ?? "#333";

function PinList({ pins }: { pins: Pin[] }) {
  return (
    <ul>
      {pins.map((pin) => (
        <li key={pin.id}>
          <Handle
            type={pin.role}
            position={pin.side === "left" ? Position.Left : Position.Right}
            id={pin.id}
          />
          <span>{pin.label}</span>
        </li>
      ))}
    </ul>
  );
}

function PartNode({ data }: NodeProps) {
  const part = data as PartData;
  const left = part.pins.filter((pin) => pin.side === "left");
  const right = part.pins.filter((pin) => pin.side === "right");
  const split = left.length > 0 && right.length > 0;
  return (
    <article className={`part part-${part.kind}`}>
      <h3>{part.title}</h3>
      {split ? (
        <div className="pin-cols">
          <PinList pins={left} />
          <PinList pins={right} />
        </div>
      ) : (
        <PinList pins={part.pins} />
      )}
    </article>
  );
}

function FitView() {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const run = () => fitView({ padding: 0.18, duration: 0 });
    run();
    window.addEventListener("resize", run);
    return () => window.removeEventListener("resize", run);
  }, [fitView]);
  return null;
}

const nodeTypes = { part: PartNode };

const nodes: Node[] = [
  {
    id: "rotary",
    type: "part",
    position: { x: 0, y: 120 },
    data: {
      title: "Rotary",
      kind: "rotary",
      pins: [
        { id: "clk", label: "CLK", side: "right", role: "target" },
        { id: "dt", label: "DT", side: "right", role: "target" },
        { id: "sw", label: "SW", side: "right", role: "target" },
        { id: "plus", label: "+", side: "right", role: "target" },
        { id: "gnd", label: "GND", side: "right", role: "target" },
      ],
    },
    draggable: true,
  },
  {
    id: "rail",
    type: "part",
    position: { x: 430, y: 0 },
    data: {
      title: "3V3 rail",
      kind: "rail",
      pins: [
        { id: "in", label: "from 3V3", side: "right", role: "target" },
        { id: "rot", label: "to +", side: "left", role: "source" },
        { id: "oled", label: "to VCC", side: "right", role: "source" },
      ],
    },
  },
  {
    id: "esp",
    type: "part",
    position: { x: 390, y: 160 },
    data: {
      title: "ESP32",
      kind: "esp",
      pins: [
        { id: "v3", label: "3V3", side: "left", role: "source" },
        { id: "g25", label: "25 CLK", side: "left", role: "source" },
        { id: "g26", label: "26 DT", side: "left", role: "source" },
        { id: "g27", label: "27 SW", side: "left", role: "source" },
        { id: "gndL", label: "GND", side: "left", role: "source" },
        { id: "gndR", label: "GND", side: "right", role: "source" },
        { id: "g22", label: "22 SCL", side: "right", role: "source" },
        { id: "g21", label: "21 SDA", side: "right", role: "source" },
      ],
    },
  },
  {
    id: "oled",
    type: "part",
    position: { x: 820, y: 150 },
    data: {
      title: "OLED",
      kind: "oled",
      pins: [
        { id: "gnd", label: "GND", side: "left", role: "target" },
        { id: "vcc", label: "VCC", side: "left", role: "target" },
        { id: "scl", label: "SCL", side: "left", role: "target" },
        { id: "sda", label: "SDA", side: "left", role: "target" },
      ],
    },
  },
];

const rawEdges: Array<{ id: string; net: NetId; source: string; sourceHandle: string; target: string; targetHandle: string }> = [
  { id: "e-v3", net: "v3", source: "esp", sourceHandle: "v3", target: "rail", targetHandle: "in" },
  { id: "e-v3-rot", net: "v3", source: "rail", sourceHandle: "rot", target: "rotary", targetHandle: "plus" },
  { id: "e-v3-oled", net: "v3", source: "rail", sourceHandle: "oled", target: "oled", targetHandle: "vcc" },
  { id: "e-clk", net: "clk", source: "esp", sourceHandle: "g25", target: "rotary", targetHandle: "clk" },
  { id: "e-dt", net: "dt", source: "esp", sourceHandle: "g26", target: "rotary", targetHandle: "dt" },
  { id: "e-sw", net: "sw", source: "esp", sourceHandle: "g27", target: "rotary", targetHandle: "sw" },
  { id: "e-gnd-rot", net: "gnd-rotary", source: "esp", sourceHandle: "gndL", target: "rotary", targetHandle: "gnd" },
  { id: "e-gnd-oled", net: "gnd-oled", source: "esp", sourceHandle: "gndR", target: "oled", targetHandle: "gnd" },
  { id: "e-scl", net: "scl", source: "esp", sourceHandle: "g22", target: "oled", targetHandle: "scl" },
  { id: "e-sda", net: "sda", source: "esp", sourceHandle: "g21", target: "oled", targetHandle: "sda" },
];

type Props = {
  selected: NetId | null;
  device: DeviceId | null;
  onSelect: (net: NetId | null) => void;
  onDevice: (id: DeviceId | null) => void;
};

const deviceIds: DeviceId[] = ["esp", "oled", "rotary", "rail"];

export function WiringFlow({ selected, device, onSelect, onDevice }: Props) {
  const [flowNodes, , onNodesChange] = useNodesState(nodes);
  const shownNodes = flowNodes.map((node) => ({
    ...node,
    className: node.id === device ? "part-selected" : "",
  }));
  const edges = useMemo<Edge[]>(
    () =>
      rawEdges.map((edge) => {
        const hot = selected === edge.net;
        const dim = selected !== null && !hot;
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle,
          targetHandle: edge.targetHandle,
          data: { net: edge.net },
          type: "smoothstep",
          animated: hot,
          style: {
            stroke: colorOf(edge.net),
            strokeWidth: hot ? 3.5 : 2,
            opacity: dim ? 0.2 : 1,
          },
        };
      }),
    [selected],
  );

  return (
    <ReactFlow
      nodes={shownNodes}
      edges={edges}
      onNodesChange={onNodesChange}
      nodeTypes={nodeTypes}
      fitView
      minZoom={0.35}
      nodesConnectable={false}
      elementsSelectable
      onEdgeClick={(_, edge) => {
        const id = (edge.data as { net: NetId } | undefined)?.net ?? null;
        onSelect(selected === id ? null : id);
      }}
      onNodeClick={(_, node) => {
        if (!deviceIds.includes(node.id as DeviceId)) return;
        const id = node.id as DeviceId;
        onDevice(device === id ? null : id);
      }}
      onPaneClick={() => {
        onSelect(null);
        onDevice(null);
      }}
      proOptions={{ hideAttribution: false }}
    >
      <FitView />
      <Background gap={18} color="#c5d0c0" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
