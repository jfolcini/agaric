# Session 3343 — Read aloud in the app

Slice S6 of #5745. The maintainer chose (2026-11-04) to ship it assuming the
webview's `speechSynthesis` works on macOS and Windows, with a Windows user
testing after release and the `tts` crate (S8) as the fallback for an OS that
fails. *Read aloud* shows only where `speech_status` answers `Webview` and the
webview has `speechSynthesis`; the status is asked once, the first time a
menu or the palette that offers it mounts, never at boot.

Entry points: the block menu's *Read aloud* row (the block with its
descendants, the selected blocks, or the text selected in the block being
edited) and the palette's *Read page aloud* and *Stop reading aloud*. The
selection reading lives in the block menu because opening the palette blurs
the roving editor and its unmount empties the selection; the selection is
serialized and passed through the S4 builder, so chips speak their titles.

`src/lib/speech/read-aloud.ts` holds the one active reading behind
`subscribe` / `getSnapshot` (plan Q7: a plain module, not a Zustand store).
Utterances are spoken one at a time with the OS voice and rate; the current
block's row carries `data-reading`. A persistent toast offers Stop, and
closing the toast stops too (the app's Toaster shows a close button, and
review caught the voice carrying on after it). A reading ends when the page
store it reads from unmounts, which also covers navigating away; a separate
navigation hook was built, shown redundant by falsification, and deleted.
`finish()` clears the reading before `cancel()`, so Chromium's `interrupted`
error for the cut utterance raises no error toast. Engine errors meaning a
missing voice or language point to the OS speech settings.

Not covered: page mode and the Edit-as-Markdown buffer have no row (the
palette command still reads the page in the page editor); a numbered block's
`list_style` ordinal is not spoken; real voices, WKWebView and WebView2 are
the device checks.

Ran: vitest over the new suites and every touched module (3673 passed),
`npm run typecheck`, `npm run lint`, `prek run --hook-stage manual
--all-files`, `e2e/read-aloud.spec.ts` (6 passed, twice) and the block-menu
and palette specs (57 passed), with each behaviour falsified once.
