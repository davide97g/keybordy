// Wi-Fi + over-the-air updates for the keybordy MP bench board (ESP32-S3 DevKitC-1).
//
// benchNetBegin() starts a background task on core 0 that joins the bench Wi-Fi, keeps
// reconnecting, and serves ArduinoOTA as <hostname>.local (port 3232, password-protected).
// Every bench sketch calls it, so a sketch flashed over the air can be replaced over the air.
// Credentials come from bench_secrets.h, which `just mp-secrets` writes from the gitignored .env.
//
// Flash over Wi-Fi: `just mp-ota <sketch>` (the board only needs power, not the USB data line).
#pragma once

#include <Arduino.h>

// log: print `wifi ...` / `ota ...` lines on Serial. Pass false in sketches that stream binary
// data over Serial (mp_mic_stream, mp_speaker_stream, mp_audio_tune), so a line cannot land in
// the middle of a packet.
void benchNetBegin(const char *hostname = "keybordy-mp", bool log = true);

bool benchNetConnected();
// "192.168.1.23", or "" while not connected.
String benchNetAddress();
// True from the first OTA chunk until the reboot: a sketch can stop audio or drawing meanwhile.
bool benchOtaActive();
// 0..100 while an OTA upload runs.
int benchOtaProgress();
