# keybordy MP: what to buy (Amazon.it)

Checked 2026-10-07 on amazon.it product pages (no location set). Prices change. Before paying, confirm three things at checkout: delivery to your address, the variant, and the colour. "FBA" means shipped by Amazon. Almost all of these are sold by a third party, not Amazon itself.

These parts are for the bench prototype (phase 1) and the printed build. The final PCB parts (ESP32 module, ICS-43434, MAX98357A, PEC11R, sockets) come from LCSC through JLCPCB assembly. See `docs/macropad.md`.

## Basket

| # | Item | Link | € | Rating | Notes |
|---|---|---|---|---|---|
| 1 | diymore ESP32-S3 DevKitC-1 **N16R8** ×2, two USB-C, variant **"ESP32 S3"** | https://www.amazon.it/dp/B0F3XMYYQY?th=1&psc=1 | 21.99 | 4.2 (106) | PCB antenna plus an unused IPEX socket ("antenna collegabile"). Skip the "con antenna", CAM, breakout and "combinato" variants. 3-pack of the same board: B0GVSGMTSQ, €24.99. |
| 2 | Waveshare 2.42" OLED 128×64 **White** (SSD1309, SPI/I2C) | https://www.amazon.it/dp/B0CL6WMHJN | 21.99 | 4.0 (35) | The part the case is drawn for. Avoid B0CL6LJWYK, which is the yellow version. |
| 3 | ARCELI INMP441 I2S mic ×3 | https://www.amazon.it/dp/B0CH2TYXCZ | 8.99 | 4.0 (95) | Bench mic, same I2S wiring as the final part. Alternative: Adafruit ICS-43434 B0DYKCZ5J8, €16.82, the exact PCB mic. |
| 4 | Hailege MAX98357 I2S 3 W amp ×3 | https://www.amazon.it/dp/B0CJY1C287 | 10.99 | 4.6 (34) | |
| 5 | Waveshare 2030 cavity speaker 8 Ω 2 W | https://www.amazon.it/dp/B0D7YLQFWQ | 10.99 | 3.9 (11) | The speaker the tray pocket is drawn for. PH1.25 lead. Measure its thickness (the layout assumes 5 mm). |
| 6 | BuyWeek EC11 encoder ×5, push, D-shaft | https://www.amazon.it/dp/B09L7QZZ46 | 14.69 | 4.3 (66) | 20 mm shaft, so on the bench the knob sits about 5 mm higher than designed. Use it to test the knob D-bore. |
| 7 | EEMB 603449 LiPo 1100 mAh, 34.5×51×6.3 mm | https://www.amazon.it/dp/B08FD39Y5R | 13.29 | 4.3 (1,480) | Fits the battery bay. Check connector polarity before plugging it in. |
| 8 | HUAREW breadboards 2×830 + 2×400 + jumpers | https://www.amazon.it/dp/B0B5TCKTQH | 14.99 | 4.5 (233) | The DevKitC-1 is wide: place it across two boards. |
| 9 | GATERON Milky Yellow Pro ×35, 5-pin linear | https://www.amazon.it/dp/B0C1477212 | 9.67 | 4.5 (60) | Milky housings suit the white caps. 22 needed, 13 spares. |
| 10 | GATERON PCB screw-in stabilizers (2u/6.25u/7u set) | https://www.amazon.it/dp/B0BZYK3X1S | 15.25 | 4.5 (48) | One 2u for the talk bar. PCB-mount, which is what the plate cutouts expect. |
| 11 | M2 cap-head screw set, 410 pcs (M2×4 to M2×20) | https://www.amazon.it/dp/B0C1BF3RM8 | 13.99 | 4.5 (128) | 4× M2×12 for the corners, 1× M2×8 for the centre |
| 12 | ruthex M2 brass heat-set inserts ×70 | https://www.amazon.it/dp/B088QJG676 | 8.49 | 4.8 (233) | Optional. The deck uses self-tapping pilot holes for now. |
| 13 | 3M Bumpon SJ5076 black Ø8×2.5 mm ×56 | https://www.amazon.it/dp/B08ZDTK9WF | 15.52 | 4.8 (23) | They sit in the four Ø10.4 recesses in the tray floor |
| 14 | Kailh MX hotswap sockets ×100 (optional) | https://www.amazon.it/dp/B096WZ6TJ5 | 13.92 | 4.8 (69) | For trying switches before the PCB arrives |

Total: about €181 without the sockets, about €195 with them.

## Don't buy

- **ECSiNG stabilizers B0C61DXN18:** plate-mount; the design uses PCB-mount.
- **RUNCCI EC11 B09SG3HF9N:** knurled shaft, not a D-shaft.
- **Hailege 2.42" B0CJY3VS12:** I2C only (4-pin). It works, but it has neither the Waveshare's outline nor its SPI interface.
- **Kailh sockets B0D6B2L3KB:** rated 1.2★.

## Checkout review (2026-10-07), still open

Items 1–13 above are in the cart: 12 listings, €172.35, free delivery. The ESP32 is the right variant. To decide before ordering, and to talk through as a smaller order for testing first:

- **Missing: 1N4148 diodes**, about €5 for 100 through-hole. The matrix needs one per switch, or multi-key presses register wrong keys. Not linked yet: Amazon blocked the search. Look for "1N4148 diodi 100 pezzi", shipped by Amazon.
- **Battery (€13.29) can wait.** The DevKit has no LiPo charger, so on the bench it can be neither charged nor used safely. Only keep it to test-fit the battery bay.
- **Stabilizers (€15.25) can wait.** They screw into the PCB, which comes with the JLCPCB order.
- **Hotswap sockets are not needed on the bench.** Female Dupont jumpers push onto the switch pins.
- **Speaker:** the plug is a 4-pin PH1.25. Cut it off and use the amp board's screw terminal.
- **Encoders:** 20 mm shafts, so bench knobs sit about 5 mm high. That's fine for testing the bore fit.
- **USB-C data cable** for the ESP32's USB port. A charge-only cable won't work.

A minimal first order for a bench test would be the ESP32, OLED, mic, amp, speaker, encoders, switches, breadboard kit and diodes. Leave out the battery, stabilizers, screws and feet until the PCB and printed case exist.
