# Session 2843 — the QR-scan spec's camera stops holding still

`e2e-tauri/sync-qr-scan.e2e.ts` ("scanning the other device's QR code pairs the two") failed again after #6007, on #6039's run 39707751106, with `no toast containing "QR code scanned" appeared`.

- **What the screenshot showed.** The scanner was open, the canvas QR was in the viewfinder, "Scanning..." was showing, and there was no error. So #6007's `getUserMedia` override held and the stream delivered frames; only the decode was failing.
- **Why the decode failed.** html5-qrcode crops the frame to its 70% qrbox and scales it to a 179 px canvas, about 2.6 px per QR module, then runs ZXing. The spec repainted the identical image every 100 ms, so every attempt saw the same pixels. A payload that fails once fails until the timeout.
- **The failed run's own payload.** Decoded from the CI screenshot, its endpoint id is the one the app log kept rejecting. In a simulation with the spec's geometry and html5-qrcode's own ZXing:
  - that payload never decodes from the still frame, and decodes once shifted by a pixel;
  - across 400 random payloads shaped like it, about 3% never decode from the still frame, and all decode within a 0–7 px shift.

**Fix:** test-only. Each repaint moves the QR one pixel, cycling through one module (8 px). A hand-held camera never shows two identical frames, so the app is unchanged.

Shown in WebKitGTK with the CI run's exact QR fed to the camera: red twice with the jitter reverted (CI's exact error), green with it. The fixed spec then passed four runs in a row on the real lane. Only CI can show the lower rate over time; a handful of green runs proves little at about 3% per run.

Suites run: `typecheck:e2e-tauri`, typecheck, lint.
