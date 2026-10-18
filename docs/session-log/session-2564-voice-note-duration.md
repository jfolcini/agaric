# Session 2564 — a WebM voice note shows its length before it is played

**Gap:** a voice note recorded on Android or Windows showed `0:00` and no
total length in its inline player until it had been played to the end.
Chromium's `MediaRecorder` records `audio/webm;codecs=opus` and writes no
Duration element in the WebM Segment Info, so `<audio>.duration` is
`Infinity` until playback reaches the last frame. Seen on the Android
emulator (API 36, WebView 133) with 9.96 s and 3.30 s notes, and reproduced
in Playwright's headless Chromium: a recorded note's player reported
`duration` `Infinity` before any play.

**Fix, in the player:** `AttachmentAudio` gives its `<audio>` a ref
callback, `resolveUnknownDuration`. On `loadedmetadata` with a non-finite
duration it seeks to `Number.MAX_SAFE_INTEGER`; the element scans for the
last frame and fires `durationchange` with the real length, and the first
finite one seeks back to 0 and unsubscribes, so a later length update during
playback leaves the playhead alone. A seek plays nothing. The rewind
supersedes the far seek before it completes, so the controls' only
`timeupdate` is at 0 and the scrubber never shows the end. The callback is
module-level, so React attaches it once per element; React 19 runs its
returned cleanup on unmount, which aborts every listener, so an element
that unmounts mid-scan is never touched again. Ogg Opus (WebKitGTK, our own
writer) and MP4 (WKWebView) report a finite duration at `loadedmetadata`,
so the callback does nothing for them; the Ogg spec still passes.

**Why not the recorder:** writing the Duration into the WebM header at save
time needs an EBML patch (no dependency for it is installed) and would leave
every note already recorded broken. The player fix covers old and new notes.
An exported WebM still lacks the header field; other players handle that
themselves.

**Tests:**
- `e2e/voice-note-record.spec.ts`: a new WebM test records through
  Chromium's `MediaRecorder`; both tests now check, right after saving and
  again after leaving the page and coming back, that the player's duration
  is between 2.5 and 4.5 s, `currentTime` is 0, it is paused with nothing
  played, and no `timeupdate` reported a non-zero time. Shown red three
  ways: the fix disabled ("Received: Infinity"), the rewind removed
  (`currentTime` "Received: 3.24"), and the rewind moved to `seeked`, which
  lets the far seek finish (a `timeupdate` at 3.24).
- `AttachmentRenderer.test.tsx`: the non-finite path seeks far and rewinds
  only once the length is finite, and not again on a later length update; a
  known length seeks nothing; after unmount the element is never seeked.
  Each shown red by removing, in turn, the abort on cleanup, the
  unsubscribe, the finite check on `durationchange`, and the finite check
  on `loadedmetadata`.
