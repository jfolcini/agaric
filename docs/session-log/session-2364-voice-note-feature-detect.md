# Session 2364 — /voice is offered only where the webview can record

#5730: WebKitGTK's `MediaRecorder` has no usable format on stock Ubuntu
GStreamer, so a voice note on Linux failed at Record even with the
microphone granted (#5725). The maintainer chose to record in the webview
with Web Audio and an Opus WASM encoder later. Until then, the app should
not offer what it can't do.

`src/components/attachments/voice-recording.ts` holds the recorder's
formats, best first (`audio/webm;codecs=opus`, then `audio/mp4`).
`supportedRecordingType()` picks from that same list, so detection and
recording can't disagree. Before this, the recorder asked for WebM only and
fell back to the webview's default.

`BlockTree` drops `voice` from slash results when `canRecordVoiceNote()` is
false, which also covers the Recent band. Reached any other way, the dialog
says "Voice notes can't be recorded on this device yet." and offers no Record
button.

Detection can't catch one case: with plugins-bad and an AAC encoder added,
WebKitGTK reports `audio/mp4` as supported and records nothing. #5730's real
fix closes that.

**Reds:**
- the helper ignoring `isTypeSupported` or its `typeof` guard;
- the filter removed;
- the dialog always rendering the recorder;
- a Playwright spec with an `addInitScript` stub, red with the filter
  mutated.

Gates:
- vitest over attachments, editor, block-tree and lib (8,331);
- typecheck, lint and oxfmt;
- Playwright `voice-note-unsupported` and the slash-command specs (27).
