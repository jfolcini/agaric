# Session 2354 — The webview grants the microphone; the AppImage camera's cause found

**The microphone (#5717).** On Linux, `allow_camera_permission` answered
WebKitGTK's `permission-request` only for the camera. A voice note's
microphone request got `Default`, which WebKitGTK treats as a denial. A
WebKitGTK 2.52.6 probe outside WebDriver showed `NotAllowedError` for both
audio and video when the request is unanswered or answered `Default`, and a
live track when it is allowed. The handler is now `allow_capture_permission`,
granting the camera and the microphone and leaving every other request to
WebKitGTK's default.

**What the e2e lane can and can't test.** Under WebDriver, WebKit grants
`getUserMedia` itself and never emits `permission-request`. A build whose
handler denied the camera still passed `camera-permission.e2e.ts`, whose
header claimed it pinned the handler. A Rust unit test is therefore the only
check of the grant. The headers now say what the specs check: that the real
webview delivers a live track from the mock capture devices.

New specs:
- `qr-scanner-camera.e2e.ts` drives the real scanner through html5-qrcode's
  own calls and expects a playing preview and no error;
- `microphone-permission.e2e.ts` is the camera spec's twin.

All three went red with the mock devices off and no reachable device.

**The AppImage camera (#5718).** The maintainer saw the scanner's
"permission" text. The cause is that the AppImage ships the GStreamer core
but no plugins, and its `AppRun` points GStreamer at the empty bundled plugin
directory. WebKitGTK then finds no camera ("no device was found amongst 0
devices" in the journal at 01:48:20), and `getUserMedia` rejects with
`OverconstrainedError: Invalid constraint`.
- The 01:45 build predates #5673. Its error mapping missed html5-qrcode's
  string error and showed the generic text.
- Main maps the same failure to "No camera was found".
- #5673's `aspectRatio` is not involved: html5-qrcode applies it to the track
  after `getUserMedia`, and every constraint combination resolves under the
  mock devices.

Bundling the plugins, which the maintainer approved once the cause was
confirmed, follows in its own PR.

Gates:
- e2e-tauri: the camera, microphone and scanner specs, 3 of 3;
- the handler's unit test;
- vitest `src/components/peers` (219);
- typecheck, including e2e-tauri;
- lint, clippy and fmt;
- Playwright `qr-scanner-camera.spec.ts` (6).
