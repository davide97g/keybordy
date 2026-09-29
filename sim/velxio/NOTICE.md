# Notice

This directory is a modified copy of Velxio.

- Upstream: https://github.com/davidmonterocrespo24/velxio
- Copyright (C) 2025 David Montero Crespo
- Base: commit `273a0ca0aa79b193050dfdbde960eb1c0347ed36` (2026-09-28), vendored without git history
- License: GNU Affero General Public License v3 (see LICENSE). The modifications are released under the same license.

## Modifications (2026-09-29)

Removed:
- Everything that only served the hosted velxio.dev service or its private "pro" overlay: the `@pro` build alias and stub, route/session/save/board-gate/SD-gate/flash-gate/hardware-serial/intellisense seams, empty overlay mount points, the backend `core/hooks.py` seams, priority build lanes and plan tiers.
- Paywall UI: PRO badges and pills, "ONLINE" ad cards linking to the hosted editor, "paid" copy on the SD card panel, the flash dialog's paid-plan gate, upgrade prompts.
- Account and sharing UI: Account menu, "My projects", Share / Embed, GitHub sync, simulation recording, BOM and screenshot export, community projects grid, project service.
- Hosted-service cruft: Google Analytics, run telemetry, UTM tagging, the "What's new" news feed (frontend and backend proxy), GitHub star prompt, SEO metadata/prerender/sitemap/robots, marketing assets, the Tauri desktop shell, the VS Code extension, the MCP servers, CI workflows, upstream docs and the commercial license file.
- The Docker build's license-key download of the QEMU runtime; `scripts/fetch-qemu.sh` copies it out of the pinned public upstream image instead.
- Raspberry Pi (Linux) and STM32 boards and their examples are hidden: their emulators are not part of the open-source code.

Changed or added:
- SD card uploads and library uninstall are available to everyone.
- `/editor?project=<name>` loads a Wokwi project folder served from `/projects/` (`frontend/src/utils/loadFromUrl.ts`, nginx JSON autoindex).
- The Wokwi importer works from plain files (`importFromWokwiSources`), maps `wokwi-esp32-devkit-v1` to the ESP32 with its pin names, and drops `$serialMonitor` wires; both import buttons share `applyWokwiImport`.
- The workspace autosaves to IndexedDB and is restored on `/editor`; Save downloads a Wokwi `.zip`.
- Backend build queue simplified to a FIFO with capped concurrent builds.
