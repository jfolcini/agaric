# Session 2540 — voice notes on WebKitGTK through WebCodecs and an in-repo Ogg writer (#5730)

**Set out to:** let `/voice` record on Linux, where WebKitGTK's
`MediaRecorder` records no format, on the route the maintainer chose on
2026-10-18: `AudioWorklet` capture, `AudioEncoder('opus')`, and an Ogg muxer of
our own.

**Shipped:**
- `voice-recorder.ts` puts both routes behind one `VoiceRecorder`: a
  `recording` promise that settles with the blob and its MIME type, and
  `stop()`. `MediaRecorder` still records wherever it has a format, unchanged.
  Elsewhere the recorder captures through `voice-capture-worklet.ts`, encodes,
  and writes pages with `OggOpusWriter` (`ogg-opus.ts`).
- `VoiceNoteDialog` drives the interface. Its size cap reads the writer's
  running byte count, which includes page overhead. Every way a recording ends
  stops the tracks and closes the `AudioContext`: Stop, Cancel, unmount, the
  microphone going away, an encoder error, and a dialog closed while the
  recorder was starting. After an encoder error, the audio encoded so far is
  saved.
- `canRecordVoiceNote` offers `/voice` when `MediaRecorder` has a format, or
  when `AudioEncoder` exists and `<audio>` can play Ogg Opus. Whether the
  encoder accepts the microphone's sample rate is asked when Record is
  pressed; a refusal shows the existing microphone error.
- `scripts/check-appimage-media-plugins.sh` also requires `libgstopus.so` and
  `libgstogg.so`, both from plugins-base.

**Traps:**
- **Wrong duration under `preload="metadata"`.** WebKitGTK sets the duration
  from however much of the file it has read, so the same blob reported 0.79,
  0.99 or 2.93 s for a 2.95 s note. This happened with the decided paging too:
  ten packets a page, and the last packet alone. Under `preload="auto"` the
  reading matched `decodeAudioData` in every run.
  - `AttachmentAudio` now uses `auto`. Its bytes are already in memory as a
    `blob:` URL, so this fetches nothing more.
  - The paging stays as decided. The research's reading of 2.79 s for
    ten-packet pages was one sample of this race.
- **Encoder calls are expensive on WebKitGTK.** One `encode` per 128-sample
  render quantum cost about three times the CPU of 2048-sample batches. The
  worklet now batches 2048 frames and drops the part-filled batch at stop
  (under 50 ms).
- **The worklet module** is imported with Vite's `?worker&url`. In a build it
  becomes a real `assets/voice-capture-worklet-*.js` file, which passes
  `script-src 'self'`; the dev server serves it as a module from the same
  origin.

**Measured** with the shipped modules in WebKitGTK 2.52.6, under xvfb with
the mock microphone and the app's CSP:
- A 3 s recording gave `audio/ogg`, and `<audio>` reported 2.95–2.99 s, equal
  to `decodeAudioData`.
- After stop, the track was `ended` and the context `closed`.
- Bitrate: WebKitGTK's Opus encoder, asked for 32 kbps, delivered 57–58 kbps
  on synthetic tone plus noise. That is about 25.5 MB an hour, so the 50 MB
  cap's auto-stop comes at about 2 hours. The mock tone came out at about
  35 kbps.
- Encoding and muxing one minute of audio took 0.38–1.1 s of wall time with
  2048-frame blocks, and 1.2–4.1 s with 128-frame blocks. The machine was
  under load (load average 13–31), so these are noisy.
- Bundle: the lazy `VoiceNoteDialog` chunk grew from 3.7 to 5.5 KB gzip, plus a
  0.3 KB worklet file. The budgeted chunks are unchanged apart from +34 B in
  `index`.

**Ran:**
- vitest: `src/components/attachments`, `src/components/editor` and `src/lib`.
- `npm run typecheck`, `typecheck:e2e`, `typecheck:e2e-tauri` and `lint`.
- prek on the touched files.
- Playwright, on a private port: `voice-note-record`, `voice-note-unsupported`
  and `attachments`.
- `e2e-tauri/voice-note-record.e2e.ts` type-checks only. No debug app build
  existed for this lane, so it has not run yet; CI's e2e-tauri lane runs it.
