# Session 2280 — The pairing scanner fills its viewfinder and starts on one press

On Android 0.18.0 the camera started (#5386's fixes), but its image did not
fit the preview box. Choosing "Scan QR code" in the pairing dialog then
needed a second "Scan QR code" press inside the scanner. The maintainer
asked for one press.

**Cause.** html5-qrcode 2.3.8 makes its video as wide as the container and
lets the camera's shape set the height. A 4:3 camera left a 256×192 strip in
the 256 px square, and a tall phone stream spilled past it. The scan box was
a fixed 250×250, taller than a 192 px image, so no frame was drawn at all.

**Fix.**
- **Square stream:** the scanner asks the camera for a square image
  (`aspectRatio: 1`). There is no `object-fit` crop, because the library
  derives the decode region from the video's on-screen size.
- **Scan box:** 70% of the video's shorter side.
- **Clipping:** the viewfinder clips. A camera that ignores the request still
  shows its frame inside the picture: a wide image is letterboxed, a tall one
  is trimmed.
- **One press:** the camera starts when the scanner opens. The start waits one
  microtask, so React StrictMode's double mount starts one camera. A failure
  from a cancelled session (closed, or replaced by Retry) is ignored.
- **Errors:** a camera error stays on the scanner, as the maintainer decided:
  the message in a live region that is mounted before it fills, and "Retry
  camera" with focus on it. The drawer's existing passphrase button is the
  way out, so no second one was added.

**Review found two bugs.**
- html5-qrcode passes a `getUserMedia` failure on as a string, while the
  message mapping only read `.name`. So a denied camera never said "Camera
  permission denied". The unit mock rejected with an `Error`, which hid it;
  it now rejects with the library's string.
- A camera error also raised a dialog banner whose Retry restarted pairing,
  not the camera, and that outlived a successful retry. The path and its
  keys are gone.

The orchestrator restored the cancelled-session guard, which review had
dropped together with the parent callbacks.

**Tests.**
- vitest pins the auto-start, StrictMode starting one camera, a quick close
  stopping the camera, Retry, the error staying on the scanner with focus,
  the live region, and the string mapping. Each was shown red.
- `e2e/qr-scanner-camera.spec.ts` runs a fake camera, square and tall, at
  phone and desktop sizes. It checks that the video fills the viewfinder,
  that the scan frame lies inside it, and that on a touch phone both error
  buttons are 44 px and the passphrase button shows the word inputs.

Gates: the peers and pairing vitest files (307), `npm run typecheck`, lint,
and the scanner and pairing Playwright specs.
