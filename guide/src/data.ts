export type NetId =
  | "v3"
  | "gnd-oled"
  | "gnd-rotary"
  | "scl"
  | "sda"
  | "clk"
  | "dt"
  | "sw";

export type Vec3 = [number, number, number];

export type DeviceId = "esp" | "oled" | "rotary" | "rail";

export type DevicePin = {
  name: string;
  meaning: string;
  net: NetId;
};

export type DeviceInfo = {
  id: DeviceId;
  title: string;
  summary: string;
  pins: DevicePin[];
};

export const devices: DeviceInfo[] = [
  {
    id: "esp",
    title: "ESP32",
    summary: "DevKit, USB toward you. Only these pins are used.",
    pins: [
      { name: "3V3", net: "v3", meaning: "3.3 V out. One pin, split on the rail for the OLED and the rotary." },
      { name: "25", net: "clk", meaning: "CLK. Each detent moves the count by 1." },
      { name: "26", net: "dt", meaning: "DT. The other rotation signal. Swap with 25 if the count runs backward." },
      { name: "27", net: "sw", meaning: "SW. Knob press. Resets the count to 0." },
      { name: "GND", net: "gnd-rotary", meaning: "Ground for the rotary. Left header." },
      { name: "GND", net: "gnd-oled", meaning: "Ground for the OLED. Right header." },
      { name: "22", net: "scl", meaning: "SCL. I2C clock to the OLED." },
      { name: "21", net: "sda", meaning: "SDA. I2C data to the OLED. Address 0x3C." },
    ],
  },
  {
    id: "oled",
    title: "OLED",
    summary: "SSD1306, 128×64. Header on the glass, left to right.",
    pins: [
      { name: "GND", net: "gnd-oled", meaning: "Ground. First pin on the left." },
      { name: "VCC", net: "v3", meaning: "3.3 V from the rail. Keeps SDA and SCL at 3.3 V." },
      { name: "SCL", net: "scl", meaning: "I2C clock. Goes to GPIO 22." },
      { name: "SDA", net: "sda", meaning: "I2C data. Goes to GPIO 21." },
    ],
  },
  {
    id: "rotary",
    title: "Rotary",
    summary: "Knob up, pins toward you, left to right.",
    pins: [
      { name: "CLK", net: "clk", meaning: "Left pin. Goes to GPIO 25." },
      { name: "DT", net: "dt", meaning: "Second pin. Goes to GPIO 26." },
      { name: "SW", net: "sw", meaning: "Third pin. Press the knob, count returns to 0. GPIO 27." },
      { name: "+", net: "v3", meaning: "3.3 V from the rail. Pull-ups on the board already go to this pin." },
      { name: "GND", net: "gnd-rotary", meaning: "Rightmost pin. Ground." },
    ],
  },
  {
    id: "rail",
    title: "3V3 rail",
    summary: "The DevKit has one 3V3 pin. This rail splits it.",
    pins: [
      { name: "3V3", net: "v3", meaning: "From the ESP32 3V3 pin, out to OLED VCC and rotary +." },
    ],
  },
];

export type Net = {
  id: NetId;
  name: string;
  color: string;
  from: string;
  to: string;
  note: string;
};

export type Segment = {
  id: string;
  net: NetId;
  a: Vec3;
  b: Vec3;
};

export const nets: Net[] = [
  {
    id: "v3",
    name: "3V3",
    color: "#d12b22",
    from: "ESP32 pin 3V3",
    to: "Rail, then OLED VCC and rotary +",
    note: "The DevKit has one 3V3 pin. Split it on the breadboard rail. VIN is 5 V from USB and stays empty.",
  },
  {
    id: "gnd-oled",
    name: "GND",
    color: "#1c1c1c",
    from: "ESP32 GND",
    to: "OLED GND",
    note: "Front of the OLED, first pin. Any GND pin on the DevKit works.",
  },
  {
    id: "scl",
    name: "SCL",
    color: "#e2b31c",
    from: "GPIO 22",
    to: "OLED SCL",
    note: "I2C clock. Address 0x3C.",
  },
  {
    id: "sda",
    name: "SDA",
    color: "#2c6bed",
    from: "GPIO 21",
    to: "OLED SDA",
    note: "I2C data.",
  },
  {
    id: "clk",
    name: "CLK",
    color: "#1f9d4e",
    from: "GPIO 25",
    to: "Rotary CLK",
    note: "Knob up, pins toward you: CLK is the left pin. Swap with DT if the count runs backward.",
  },
  {
    id: "dt",
    name: "DT",
    color: "#6d45c4",
    from: "GPIO 26",
    to: "Rotary DT",
    note: "Second pin from the left.",
  },
  {
    id: "sw",
    name: "SW",
    color: "#e07a1a",
    from: "GPIO 27",
    to: "Rotary SW",
    note: "Third pin. Pressing the knob resets the count to 0.",
  },
  {
    id: "gnd-rotary",
    name: "GND",
    color: "#1c1c1c",
    from: "ESP32 GND",
    to: "Rotary GND",
    note: "Rightmost pin on the encoder. Use a second GND pin on the DevKit.",
  },
];

const y = 0.32;

export const segments: Segment[] = [
  { id: "v3-board", net: "v3", a: [-1.55, y, -2.15], b: [-2.55, y, -2.15] },
  { id: "v3-oled", net: "v3", a: [-2.55, y, -2.15], b: [-3.45, y, -0.7] },
  { id: "v3-rot", net: "v3", a: [-2.55, y, -2.15], b: [3.45, y, 0.6] },
  { id: "gnd-oled", net: "gnd-oled", a: [1.55, y, -2.15], b: [-3.45, y, -1.1] },
  { id: "scl", net: "scl", a: [1.55, y, -1.15], b: [-3.45, y, -0.3] },
  { id: "sda", net: "sda", a: [1.55, y, -0.15], b: [-3.45, y, 0.1] },
  { id: "clk", net: "clk", a: [-1.55, y, -0.15], b: [3.45, y, -0.6] },
  { id: "dt", net: "dt", a: [-1.55, y, 0.25], b: [3.45, y, -0.2] },
  { id: "sw", net: "sw", a: [-1.55, y, 0.65], b: [3.45, y, 0.2] },
  { id: "gnd-rot", net: "gnd-rotary", a: [-1.55, y, 1.45], b: [3.45, y, 1.0] },
];

export const session = [
  {
    title: "Board identified",
    body: "ESP32-D0WD-V3 DevKit, CP2102, 4 MB flash. Port /dev/cu.usbserial-0001.",
  },
  {
    title: "OLED up",
    body: "SSD1306 on I2C 0x3C. SDA 21, SCL 22, VCC from 3V3.",
  },
  {
    title: "Count on the glass",
    body: "Turning the knob changes a signed integer. One click, one step.",
  },
  {
    title: "Knob resets",
    body: "Pressing the knob returns the number to 0.",
  },
];
