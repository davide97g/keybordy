## Learned User Preferences

## Learned Workspace Facts

- Connected board is an ESP32-D0WD-V3 (rev 3.0) DevKit with a CP2102 USB-UART and 4 MB flash (DIO, 80 MHz). On this Mac the serial port is `/dev/cu.usbserial-0001`.
- Chip, flash, eFuse, and partition notes are in `docs/esp32-connection.md`. NVS and SPIFFS were left unread because they can hold Wi-Fi credentials.
- SSD1306 128x64 OLED on I2C address `0x3C`: SDA GPIO21, SCL GPIO22, VCC from the DevKit `3V3` pin so the I2C lines stay at 3.3 V.
- Rotary encoder with onboard pull-ups: CLK GPIO25, DT GPIO26, SW GPIO27, `+` to `3V3`. `firmware/rotary_oled/rotary_oled.ino` shows a signed count; pressing the knob resets it to 0.
- Three MX-style 3-pin blue switches (BTFO, 50-pack) are wired to GPIO32, GPIO33, and GPIO14. Each has one metal pin on the GPIO and the other on a GND line shared with the other switches (the DevKit has only 2 GND pins), with the internal pull-up enabled. `firmware/switches_oled/switches_oled.ino` shows the last key pressed as a large number and a box per key that fills while that key is held.
- Leave GPIO 0, 2, 12, and 15 free (boot straps) and leave GPIO 1 and 3 free (USB serial).
- Flash that sketch with `arduino-cli`, FQBN `esp32:esp32:esp32`, and the Adafruit SSD1306 and Adafruit GFX libraries.
