# Session 1942 — the QR scanner no longer crashes Settings (#5386, frontend slice)

Pairing's QR scanner threw Settings into the error boundary ("An unexpected
error occurred") instead of showing the camera or a camera error. #5386 also
covers the camera never being granted on Linux (WebKitGTK permission) and
Android; this PR is only the frontend crash.

Two library behaviours caused it (`node_modules/html5-qrcode/esm/html5-qrcode.js`):

- `start()` empties its container (`clearElement`, `innerHTML = ""`). The
  container was the `<section>` that also held React's "Camera preview" and
  error paragraphs, so React's next commit tried to remove a node that was
  gone and threw `NotFoundError`.
- `stop()` throws a bare string synchronously unless the scanner is running,
  so the `.catch` on the unmount and post-scan stops never ran.

What shipped (`src/components/peers/QrScanner.tsx`): html5-qrcode gets its
own empty child div; every stop goes through a guard that skips it unless the
scanner started and turns a synchronous throw into a logged rejection; an
unmount while `start()` is still pending stops the camera once it settles.
The test mock now mirrors the library (empties on start, scanning only after
render, string throw from stop), citing its source lines.

Left for the Linux/Android slice: the WebKitGTK permission handler, the
GStreamer camera source in packaging, a fake-camera Chromium e2e and an
`e2e-tauri` spec, and the device checks.

Verified: 10 of 23 tests fail against the pre-fix component with the new mock;
reviewer re-falsified the separate container and the stop guard on copies;
`src/components/peers` 222 passed; typecheck exit 0; oxlint and oxfmt clean.
