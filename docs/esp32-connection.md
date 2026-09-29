# ESP32 USB connection

Read on this Mac on 27 Sep 2026 with `esptool` 5.4.0 and `espefuse` 5.4.0 (`brew install esptool`). Every command was read-only. The board was reset into the ROM bootloader over the CP2102 and then hard-reset back to the app.

NVS and SPIFFS were not read.

## USB

| | |
|---|---|
| Bridge | Silicon Labs CP2102 USB to UART Bridge Controller |
| Port | `/dev/cu.usbserial-0001` |
| USB serial | `0001` |
| Vendor ID | `0x10C4` (4292) |
| Product ID | `0xEA60` (60000) |

Use the `cu` port. `/dev/tty.usbserial-0001` is the same device.

## Chip

| | |
|---|---|
| Chip | ESP32-D0WD-V3 (revision v3.0) |
| Package code | 1 (esptool name ESP32-D0WD-V3, not the 6×6 D0WDQ6) |
| Features | Wi-Fi, Bluetooth, dual core + LP core, 240 MHz |
| Crystal | 40 MHz |
| CPU rating | Rated. Not limited to 160 MHz |
| ADC Vref | 1107 mV |
| Coding scheme | None (BLK1–3 are 256 bits) |

Classic ESP32 has no separate chip ID. `esptool chip-id` returns the MAC.

`esptool get-security-info` fails on this chip: `Failed to get security info (result was FF00: Command not implemented)`. Security state below comes from eFuses.

## MAC

The board's MAC is kept out of the repo. It lives in `.env` (gitignored) as `ESP32_BASE_MAC`; copy `.env.example` to `.env` and fill it in, or read it again with `esptool --port /dev/cu.usbserial-0001 read-mac`. The eFuse CRC check on it passed.

Espressif derives the other addresses from that base:

| Interface | MAC |
|---|---|
| Wi-Fi station | `ESP32_BASE_MAC` |
| Wi-Fi AP | `ESP32_BASE_MAC` + 1 |
| Bluetooth | `ESP32_BASE_MAC` + 2 |
| Ethernet | `ESP32_BASE_MAC` + 3 |

Custom MAC in BLOCK3 is unset (`00:00:00:00:00:00`).

## Flash chip

| | |
|---|---|
| JEDEC manufacturer | `0x68` |
| JEDEC device | `0x4016` |
| Size | 4 MB |
| Voltage | 3.3 V, set by the GPIO12 strapping pin |
| SFDP | Present (`53 46 44 50`, ASCII `SFDP`) |
| Status register | `0x0200` |

esptool does not name manufacturer `0x68`. `0x4016` is the usual 32 Mbit / 4 MB density code.

Image header on both the bootloader and the running app: mode DIO, frequency 80 MHz, size 4 MB.

## Security eFuses

| Fuse | Value |
|---|---|
| Secure boot V1 (`ABS_DONE_0`) | off |
| Secure boot V2 (`ABS_DONE_1`) | off |
| Flash encryption counter | 0 (encryption off) |
| Flash encryption config | 0 |
| Secure version | 0 |
| JTAG | enabled |
| UART download | enabled |
| Flash cache in UART bootloader | enabled |
| Bluetooth | enabled |
| App CPU | enabled |
| Write-disable mask | 0 |
| Read-disable (BLOCK1–3) | 0 |
| ROM BASIC console | disabled (`CONSOLE_DEBUG_DISABLE`) |

BLOCK1 (flash encryption key), BLOCK2 (secure boot key), and BLOCK3 are all zeros. Nothing is burned. Those keys are still writable.

## Flash map

Partition table at `0x8000`. Magic `0x50AA`.

| Name | Type | Offset | Size |
|---|---|---|---|
| nvs | data / nvs | `0x9000` | 20 KB |
| otadata | data / ota | `0xE000` | 8 KB |
| app0 | app / ota_0 | `0x10000` | 1280 KB |
| app1 | app / ota_1 | `0x150000` | 1280 KB |
| spiffs | data / spiffs | `0x290000` | 1408 KB |
| coredump | data / coredump | `0x3F0000` | 64 KB |

OTA select sequence is `1`, so the active slot is `app0`. The second OTA record is erased (`0xFFFFFFFF`).

## Firmware

Bootloader at `0x1000`. ESP32 image, version 1, checksum and validation hash valid.

| | |
|---|---|
| ESP-IDF | `v5.5.1-418-gf1a1df9b2e` |
| Bootloader version | 1 |
| Compile time | Nov 4 2025 11:18:32 |
| Entry | `0x400805b4` |
| Segments | 3 |
| Hash | `765a0dec9964d9a265994cb436c3b78d251bb692413918e83e247f856d636b91` |

`app0` is a valid ESP32 image (magic `0xE9`, 6 segments, entry `0x40081cd8`). App description:

| | |
|---|---|
| Project | `arduino-lib-builder` |
| Version | `64767cc` |
| ESP-IDF | `v5.5.1-418-gf1a1df9b2e` |
| Built | Nov 4 2025 11:02:57 |
| Secure version | 0 |

`app1` does not start with an ESP image. First byte is `0x52`, not `0xE9`.

## Commands

```sh
esptool --port /dev/cu.usbserial-0001 chip-id
esptool --port /dev/cu.usbserial-0001 read-mac
esptool --port /dev/cu.usbserial-0001 flash-id
esptool --port /dev/cu.usbserial-0001 read-flash-status
esptool --port /dev/cu.usbserial-0001 read-flash-sfdp 0 4
espefuse --port /dev/cu.usbserial-0001 --chip esp32 summary
esptool --port /dev/cu.usbserial-0001 read-flash 0x1000 0x7000 bootloader.bin
esptool image-info bootloader.bin
```
