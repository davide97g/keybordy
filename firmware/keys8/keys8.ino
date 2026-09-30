// No breadboard: every board pin takes exactly one jumper, so the switches
// cannot share one GND line. Each switch gets two pins of its own:
//   leg A -> KEY_PINS[i]  (input, internal pull-up)
//   leg B -> GND_PINS[i]  (a real GND pin, or a GPIO held LOW as a ground)
// Rotary encoder, added later: CLK 34, DT 35, SW 39 (input-only pins, the
// module's own pull-ups hold them high), + to 3V3, GND to the second GND pin.
//
// Over Bluetooth LE the board is a keyboard named "keybordy": K1..K8 press
// F13..F20, keys no app uses, so host/hammerspoon maps each one to an action.
// Serial keeps printing `key N down/up` for the simulator and debugging.
#include <BLEDevice.h>
#include <BLEHIDDevice.h>
#include <BLESecurity.h>
#include <BLEServer.h>
#include <esp_mac.h>

static const int KEY_PINS[] = {32, 33, 14, 13, 4, 18, 19, 23};
static const int GND_PINS[] = {-1, 25, 26, 27, 16, 17, 21, 22};  // -1: K1 uses a real GND pin
static const int KEY_COUNT = sizeof(KEY_PINS) / sizeof(KEY_PINS[0]);

// HID usages F13..F20 (0x68..0x6F), one per key.
static const uint8_t KEY_USAGES[] = {0x68, 0x69, 0x6A, 0x6B, 0x6C, 0x6D, 0x6E, 0x6F};

// Blue switches bounce for a few ms on both press and release.
static const uint32_t DEBOUNCE_MS = 15;

struct Key {
  int stable;
  int lastRead;
  uint32_t lastChange;
};

Key keys[KEY_COUNT];

// Boot keyboard layout with report ID 1. The usage range goes to 0xE7 rather
// than the usual 0x65, or F13..F20 would be out of range.
static const uint8_t REPORT_MAP[] = {
  0x05, 0x01,  // Usage Page (Generic Desktop)
  0x09, 0x06,  // Usage (Keyboard)
  0xA1, 0x01,  // Collection (Application)
  0x85, 0x01,  //   Report ID (1)
  0x05, 0x07,  //   Usage Page (Keyboard)
  0x19, 0xE0,  //   Usage Minimum (Left Control)
  0x29, 0xE7,  //   Usage Maximum (Right GUI)
  0x15, 0x00,  //   Logical Minimum (0)
  0x25, 0x01,  //   Logical Maximum (1)
  0x75, 0x01,  //   Report Size (1)
  0x95, 0x08,  //   Report Count (8)
  0x81, 0x02,  //   Input (Data, Variable, Absolute): modifiers
  0x95, 0x01,  //   Report Count (1)
  0x75, 0x08,  //   Report Size (8)
  0x81, 0x01,  //   Input (Constant): reserved
  0x95, 0x06,  //   Report Count (6)
  0x75, 0x08,  //   Report Size (8)
  0x15, 0x00,  //   Logical Minimum (0)
  0x25, 0xE7,  //   Logical Maximum (0xE7)
  0x05, 0x07,  //   Usage Page (Keyboard)
  0x19, 0x00,  //   Usage Minimum (0)
  0x29, 0xE7,  //   Usage Maximum (0xE7)
  0x81, 0x00,  //   Input (Data, Array): up to 6 keys
  0xC0,        // End Collection
};

BLECharacteristic *input;
volatile bool connected = false;

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *) override {
    connected = true;
    Serial.println("ble connected");
  }
  void onDisconnect(BLEServer *) override {
    connected = false;
    Serial.println("ble disconnected");
    BLEDevice::startAdvertising();
  }
};

// The simulator's QEMU has no radio: BLEDevice::init stalls the whole chip
// there. QEMU always boots with this factory MAC, no real board has it.
bool inSimulator() {
  static const uint8_t QEMU_MAC[6] = {0x10, 0x01, 0x00, 0xC4, 0x0A, 0x24};
  uint8_t mac[6];
  esp_efuse_mac_get_default(mac);
  return memcmp(mac, QEMU_MAC, sizeof(mac)) == 0;
}

void startBle() {
  BLEDevice::init("keybordy");

  // "Just Works" pairing with bonding: no PIN, the Mac reconnects on its own.
  BLESecurity *security = new BLESecurity();
  security->setCapability(ESP_IO_CAP_NONE);
  security->setAuthenticationMode(true, false, true);

  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  BLEHIDDevice *hid = new BLEHIDDevice(server);
  hid->manufacturer()->setValue("keybordy");
  hid->pnp(0x02, 0xE502, 0xA111, 0x0210);
  hid->hidInfo(0x00, 0x01);
  hid->reportMap((uint8_t *)REPORT_MAP, sizeof(REPORT_MAP));
  input = hid->inputReport(1);
  hid->setBatteryLevel(100);
  hid->startServices();

  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->setAppearance(HID_KEYBOARD);
  advertising->addServiceUUID(hid->hidService()->getUUID());
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.println("ble advertising");
}

// Sends every key that is down, so chords and overlapping presses stay right.
void sendReport() {
  if (!connected) return;
  uint8_t report[8] = {0};
  int slot = 2;
  for (int i = 0; i < KEY_COUNT && slot < 8; i++) {
    if (keys[i].stable == LOW) report[slot++] = KEY_USAGES[i];
  }
  input->setValue(report, sizeof(report));
  input->notify();
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < KEY_COUNT; i++) {
    if (GND_PINS[i] >= 0) {
      pinMode(GND_PINS[i], OUTPUT);
      digitalWrite(GND_PINS[i], LOW);
    }
    pinMode(KEY_PINS[i], INPUT_PULLUP);
    keys[i] = {HIGH, HIGH, 0};
  }
  Serial.println("keys8 ready");
  if (inSimulator()) {
    Serial.println("ble off in simulator");
  } else {
    startBle();
  }
}

void loop() {
  uint32_t now = millis();

  for (int i = 0; i < KEY_COUNT; i++) {
    Key &k = keys[i];
    int read = digitalRead(KEY_PINS[i]);
    if (read != k.lastRead) {
      k.lastChange = now;
      k.lastRead = read;
    }
    if ((now - k.lastChange) > DEBOUNCE_MS && read != k.stable) {
      k.stable = read;
      Serial.printf("key %d %s\n", i + 1, k.stable == LOW ? "down" : "up");
      sendReport();
    }
  }
}
