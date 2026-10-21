# Session 2772 — the QR-scan pairing spec's camera override moves to the prototype

The maintainer asked for the open flakes. A sweep of CI since 2026-10-17 found one still open: `e2e-tauri/sync-qr-scan.e2e.ts` failed with `no toast containing "QR code scanned" appeared` on 4 of about 14 runs, three of them Dependabot bumps it cannot depend on (runs 39298538454 attempt 1, 39322041615, 39322107911, 39340290115). Every other red in that window was already fixed on `main`; session 2771 lists them.

The failure screenshot showed the scanner playing WebKitGTK's mock capture device (the "Bip" test pattern), not the canvas the spec draws the peer's QR on. The spec replaced `getUserMedia` as an own property of `navigator.mediaDevices`. A probe run locally showed the property gone once Settings had opened, on the same document (a window marker and `performance.timeOrigin` unchanged): WebKit collected the `MediaDevices` wrapper and gave the page a new one, and an expando lives only on the wrapper. Whether the wrapper is collected before the scanner starts is GC timing, hence the intermittency. The override now goes on `MediaDevices.prototype`, which the global keeps alive.

Locally the old form failed 2 of 2 runs and the new one passed 14 of 15. The one miss showed the canvas QR in the viewfinder and never decoded it, which is a second, rarer cause: html5-qrcode decodes the centre 70% of the 256 px viewfinder at CSS-pixel size, about 179 px, so this pairing QR (69 modules with its quiet zone) gets about 2.6 px per module.

Suites run: `just e2e-real e2e-tauri/sync-qr-scan.e2e.ts` (the build, then repeated runs with `WDIO_SKIP_TAURI_BUILD=1`), and a probe copy of the spec that was not committed.
