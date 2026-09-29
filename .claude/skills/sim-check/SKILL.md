---
name: sim-check
description: Validate keybordy firmware and wiring in the local simulator without a browser. Use after editing a sketch in firmware/, firmware/*/diagram.json or the README pin table; when asked to "run the simulation", "test the firmware", "check the wiring", "press a key in the sim" or to see serial output; or before flashing.
---

# Headless simulator checks

Tool: `sim/harness/simcheck.py`, wrapped by `just sim-lint`, `just sim-run` and `just sim-check`. The full reference is in the "Headless checks" section of the root `CLAUDE.md`.

## Steps

1. **Lint first.** It needs no container: `just sim-lint [name]`. Fix every `FAIL`. Treat each `WARN` as something to explain to the user or fix.
2. **Make sure the simulator is up.** `docker ps --format '{{.Names}}' | grep -x velxio`, else `just sim-up`. Docker Desktop must be running; if it isn't, ask the user to start it.
3. **Full check:** `just sim-check [name]`, then `just sim-check [name] --bounce` if the change touches debounce or key scanning. PASS on both is the bar.
4. **Specific behavior:** write a scenario, for example
   `just sim-run keys8 -s "until ready; press K2; wait 500; release K2; expect 'key 2 up'"`.
   Add `--json` to parse the result (`ok`, `problems`, `warnings`, `serial[{t_ms,line}]`). Add `-v` to stream serial live.
5. **Trying an idea without touching the repo:** copy `firmware/<name>/` into the scratchpad, edit the copy, and pass its path as `name`.
6. **Report the result:** PASS/FAIL, the decisive serial lines, and any `FAIL` or `WARN` text as printed. A PASS in the simulator is not a PASS on hardware; say so when flashing is the next step (`just fw-flash`, then read serial as `CLAUDE.md` describes).

## Reading failures

- `input with no pull and no driver`: the sketch forgot `INPUT_PULLUP`, or the pin is 34–39.
- `neither side is GND or a GPIO held LOW`: a `GND_PINS` entry is not driven LOW, or the leg is on the wrong pin.
- `N key lines for M taps`: chatter got through (debounce) or a phantom press happened at boot.
- `short circuit`: two outputs, or an output and a supply, meet on one net.
- `resets`, `panic`, `crash`: read the serial lines around it (`--json`, or `-v`).
- `compile failed`: the stderr tail is printed. A missing library means the sketch needs one the container does not have.
- The harness only models `wokwi-pushbutton` and `wokwi-ky-040`. Any other part is inert, so say so rather than trust a PASS for it.
