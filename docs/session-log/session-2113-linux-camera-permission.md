# Session 2113 — Linux answers the webview's camera permission request

Cause 2 of #5386: WebKitGTK denies a `permission-request` nobody answers, and
the app answered none, so on Linux the pairing QR scanner's `getUserMedia`
failed with `NotAllowedError` even after #5392 stopped the crash.

Tauri 2.12.1 exposes `Builder::on_permission_request`, applied to every webview
(the maintainer's first choice on the issue), so the fix needs no new runtime
dependency: `allow_camera_permission` in `lib.rs` returns `Allow` for
`PermissionKind::Camera` and `Default` for everything else, leaving those to
WebKitGTK. Granting without a prompt is safe because the webview loads only the
app's own origin (threat model). Linux only; other platforms are unchanged.

For testing invariant 4 the e2e-tauri runner needs a camera it does not have:
under `AGARIC_E2E_SANDBOX`, `setup_app` turns on WebKitGTK's mock capture
devices through `with_webview`, which needs `webkit2gtk` as a direct Linux
dependency at the 2.0.2 Tauri already resolves (both lockfiles gained only the
edge). `e2e-tauri/camera-permission.e2e.ts` asserts `getUserMedia({video:
true})` resolves with a live track. It could not run here (no tauri-driver);
this PR's real-backend lane is its first run. Unconfirmed until then: whether
WebKitGTK honours the mock setting when enabled after load.

Docs: `docs/architecture/sync-and-network.md` says how camera access works per
platform; `docs/BUILD.md` names the GStreamer capture source a real camera
needs on Linux. Still manual for the maintainer: the Pixel 8 check and a real
webcam on Linux.

Gates: `cargo check`, clippy, `cargo fmt`, the `app_paths` tests and
`ts_bindings_up_to_date`, `tsc -p tsconfig.wdio.json`, oxlint, oxfmt,
`npx vitest run e2e-tauri`, the vault-isolation and driver-gate checks, and
`prek run --files` over the touched files.
