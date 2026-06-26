# Session 1000 — mobile pairing QR: camera guard, SVG prolog strip

Investigated a report that the mobile pairing dialog crashes shortly after opening
and that QR scanning "doesn't work at all".

## Findings

- The crash is almost certainly **native** (Android WebView/renderer), not a JS
  throw: the app is wrapped in an `ErrorBoundary`, so a render-time exception would
  show a fallback rather than kill the process. `pairingOpen` is local state
  (defaults `false`), so relaunch lands on the restored Settings → Devices route
  where the same path is retriggered.
- Both symptoms most plausibly share the live-camera / `getUserMedia` path.
- **Camera availability is a permissions/build issue.** The Android `CAMERA`
  permission and the WebChromeClient grant live only in the **gitignored**
  `src-tauri/gen/android/` tree, so a clean checkout / CI / `tauri android init`
  regen rebuilds the manifest without camera permission → scanning silently fails.

## Changes

- `QrScanner.tsx`: guard `navigator.mediaDevices?.getUserMedia` before constructing
  html5-qrcode; on absence show a clear "camera unavailable, use the passphrase"
  message and fall back to manual entry. On failure, classify `DOMException.name`
  (`NotAllowedError`→denied, `NotFoundError`/`OverconstrainedError`→not found) so
  the surfaced message and logs reveal the actual cause.
- `pairing.rs` `generate_qr_svg`: strip the `<?xml …?>` prolog the `qrcode` crate
  emits so the returned markup is a bare `<svg>…</svg>` fragment, valid for
  `dangerouslySetInnerHTML`. Regression test added.
- New i18n keys: `qrScanner.cameraUnavailable` / `cameraDenied` / `cameraNotFound`.

The native crash itself is unconfirmed without a device `logcat`; the guard removes
the no-`mediaDevices` failure path. Making the Android `CAMERA` permission
reproducible (committing `gen/android` or a CI manifest-patch step) is deferred.

## Release

- **0.7.1** cut for this fix.
