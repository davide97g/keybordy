# Velxio (keybordy fork)

A local, single-user fork of [Velxio](https://github.com/davidmonterocrespo24/velxio) by David Montero Crespo: an open-source multi-board emulator and circuit simulator (Arduino AVR, RP2040, ESP32 / S3 / C3 in QEMU, SPICE analog), with a Monaco editor and a Wokwi-style canvas.

This copy runs the keybordy simulator (`../compose.yaml`, see `../README.md`). What changed from upstream is listed in [NOTICE.md](NOTICE.md). If Velxio is useful to you, consider supporting the upstream project: https://github.com/sponsors/davidmonterocrespo24

## Layout

- `frontend/`: React + Vite + TypeScript app (`npm install`, `npm run dev`, `npm test`)
- `backend/`: FastAPI compile/simulation server (arduino-cli, ESP-IDF, QEMU workers)
- `docker/`: nginx config and entrypoint for the all-in-one image
- `Dockerfile`: the image; needs `prebuilt/qemu/` filled by `scripts/fetch-qemu.sh`
- `test/fixtures/`: data files some frontend tests read

## License

GNU AGPLv3, see [LICENSE](LICENSE). Upstream also sells a commercial license; that offer does not extend to this fork, which is AGPLv3 only.
