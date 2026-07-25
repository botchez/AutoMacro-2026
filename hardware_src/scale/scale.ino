// ESP32 load-cell scale (HX711) — streams weight over serial, accepts commands.
//
// Hardware:
//   ESP32-WROOM-32 dev module
//   HX711 amplifier powered from 3V3
//   HX711 DT  -> GPIO 32
//   HX711 SCK -> GPIO 33
//   4-wire load cell on E+/E-/A+/A-, channel B unused
//
// Serial protocol (115200 baud, newline-terminated commands):
//   t          tare, replies "tared"
//   f<number>  set calibration factor, replies "factor <value>"
//   p          replies "factor <value>"
// Otherwise the loop prints one weight reading per line, ~10 lines/sec.

#include "HX711.h"

#define DOUT_PIN 32
#define SCK_PIN 33
#define CALIBRATION_FACTOR 423.1

HX711 scale;
float calibrationFactor = CALIBRATION_FACTOR;

void setup() {
  Serial.begin(115200);
  scale.begin(DOUT_PIN, SCK_PIN);   // data pin first, clock second
  scale.set_scale(calibrationFactor);
  scale.tare();
}

void handleCommand(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) {
    return;
  }

  char c = cmd.charAt(0);
  if (c == 't') {
    scale.tare();
    Serial.println("tared");
  } else if (c == 'f') {
    calibrationFactor = cmd.substring(1).toFloat();
    scale.set_scale(calibrationFactor);
    Serial.print("factor ");
    Serial.println(calibrationFactor, 1);
  } else if (c == 'p') {
    Serial.print("factor ");
    Serial.println(calibrationFactor, 1);
  }
}

void loop() {
  while (Serial.available() > 0) {
    String cmd = Serial.readStringUntil('\n');
    handleCommand(cmd);
  }

  Serial.println(scale.get_units(1), 1);
  delay(10);   // ~10 readings per second
}
