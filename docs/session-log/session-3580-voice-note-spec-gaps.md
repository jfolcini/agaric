# Session 3580 — voice-note spec gaps: cancel, denied microphone, restart (#5364)

Filled the three gaps in the voice-note specs; no app code changed.

- `e2e/voice-note-record.spec.ts`, cancel: record, Cancel, then the microphone track is `ended` and the block has no attachment after reopening the page. Red when unmount stopped discarding the recording (one attachment saved), and when it stopped the recorder no longer (track `live`).
- Same file, denied microphone: the toast "Microphone access was denied", Record enabled, the timer at 0:00, and no attachment after reopening. Red when `NotAllowedError` no longer mapped to `voiceNote.micDenied` (no toast).
- Chromium under Playwright cannot report a blocked microphone as a user sees it: `--use-fake-ui-for-media-stream` grants it whatever the permission says (CDP `Browser.setPermission` included), and without the flag it answers `NotFoundError` or `NotSupportedError`. So the denied case stubs `getUserMedia` to reject with `NotAllowedError`.
- `e2e-tauri/voice-note-record.e2e.ts`: a second `it` restarts the app (`restartApp`), reopens the page and plays the note the first case recorded, muted so the webview's autoplay policy lets a script start it. Passed under `just e2e-real`; red, "the voice note never played after the restart", with a player that pauses itself on play, while the first case stayed green.
- Trap: the real-backend runner needs `webkit2gtk-driver`, `openbox` and `cargo install tauri-driver --locked`, which this container lacks; with them, `bash scripts/e2e-tauri-local.sh` runs it (`just` is not installed).
