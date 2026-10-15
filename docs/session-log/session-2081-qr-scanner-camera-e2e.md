# Session 2081 — The pairing QR scanner gets a fake-camera e2e spec

#5392 fixed the pairing scanner crash, but only unit tests with a mocked
html5-qrcode pinned it, and the vitest DOM has no camera.
`e2e/qr-scanner-camera.spec.ts` runs the mock lane's Chromium with its fake
camera and the permission granted, walks Settings › Sync & Devices › Pair new
device › Have a code › Scan QR code, starts the scanner, and asserts the
`<video>` is visible, which Playwright only grants a non-empty box. The two
"Scan QR code" buttons are told apart by the entry-mode toggle's "Recommended"
badge.

Falsified against a copy of `QrScanner.tsx`: dropping the container's `w-full`
reddened the visibility assertion with the video present at zero size, and
putting the placeholder back inside html5-qrcode's container reddened it with
the video gone, the console gate also failing on React's `removeChild` error.
A trailing "no crash panel" assertion was never the red in either case, so it
was deleted. Three consecutive green runs plus one after that edit; oxlint,
oxfmt and `npm run typecheck` clean.

Refs #5386: the Linux camera permission handler, its e2e-tauri spec and the
device checks remain.
