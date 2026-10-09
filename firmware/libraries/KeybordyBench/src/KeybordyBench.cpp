#include "KeybordyBench.h"

#include <ArduinoOTA.h>
#include <WiFi.h>

#if __has_include("bench_secrets.h")
#include "bench_secrets.h"
#else
#error "bench_secrets.h is missing: run `just mp-secrets` (it reads ESP32_WIFI_SSID/PASS and ESP32_OTA_PASS from .env)"
#endif

static char s_host[32];
static bool s_log;
static volatile bool s_connected, s_ota;
static volatile int s_progress;
static char s_addr[16];

static void netTask(void *) {
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(s_host);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);  // modem sleep drops pings and OTA invitations between beacons
  WiFi.begin(BENCH_WIFI_SSID, BENCH_WIFI_PASS);

  ArduinoOTA.setHostname(s_host);
  ArduinoOTA.setPassword(BENCH_OTA_PASS);
  ArduinoOTA.onStart([] {
    s_ota = true;
    s_progress = 0;
    if (s_log) Serial.println("ota start");
  });
  ArduinoOTA.onProgress([](unsigned int done, unsigned int total) { s_progress = total ? done * 100 / total : 0; });
  ArduinoOTA.onEnd([] {
    if (s_log) Serial.println("ota done, rebooting");
  });
  ArduinoOTA.onError([](ota_error_t e) {
    s_ota = false;
    if (s_log) Serial.printf("ota error %u\n", (unsigned)e);
  });

  bool otaUp = false;
  uint32_t lastTry = millis();
  for (;;) {
    bool up = WiFi.status() == WL_CONNECTED;
    if (up && !s_connected) {
      snprintf(s_addr, sizeof s_addr, "%s", WiFi.localIP().toString().c_str());
      if (!otaUp) {
        ArduinoOTA.begin();  // also announces <host>.local over mDNS
        otaUp = true;
      }
      if (s_log) Serial.printf("wifi connected %s (%s.local), ota ready\n", s_addr, s_host);
    } else if (!up && s_connected) {
      s_addr[0] = 0;
      if (s_log) Serial.println("wifi lost, reconnecting");
    }
    s_connected = up;
    if (!up && millis() - lastTry > 15000) {  // a router reboot or a wrong band: keep trying
      lastTry = millis();
      WiFi.disconnect();
      WiFi.begin(BENCH_WIFI_SSID, BENCH_WIFI_PASS);
    }
    if (otaUp) ArduinoOTA.handle();
    vTaskDelay(pdMS_TO_TICKS(up ? 20 : 250));
  }
}

void benchNetBegin(const char *hostname, bool log) {
  static bool started;
  if (started) return;
  started = true;
  snprintf(s_host, sizeof s_host, "%s", hostname);
  s_log = log;
  xTaskCreatePinnedToCore(netTask, "benchNet", 8192, nullptr, 1, nullptr, 0);
}

bool benchNetConnected() { return s_connected; }
String benchNetAddress() { return String(s_addr); }
bool benchOtaActive() { return s_ota; }
int benchOtaProgress() { return s_progress; }
