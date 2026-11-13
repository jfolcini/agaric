# Session 4041 — `agaric://capture?text=` opens Quick Capture prefilled

First checkbox of #6555, continued in a cloud session from the overnight batch's parked `wip:` commit (#6667).

**What it does.** The Rust deep-link router gains a fourth host, `capture`, that takes one query parameter, `text`, and emits `deeplink:capture` with a tagged `CapturePayload` (`prefill { text }` or `tooLong`). `useAppDialogs`, which owns the Quick Capture dialog, listens for it and opens the dialog holding the text. The link never saves: the user presses *Capture*.

**Trust boundary.** Any app or web page can fire the link, so:

- `text` is decoded strictly as form encoding (`+` is a space). `url`'s own decoder passes a bad `%` escape and non-UTF-8 bytes through altered, so a hand decoder refuses both and drops the link.
- It is bounded by the block content cap (`MAX_CONTENT_LENGTH`, UTF-8 bytes). An over-long text opens nothing and toasts why, as an over-long block is refused at save, not cut.
- A second link while the dialog is open goes below what the user typed, never over it. Each link is a new prefill object, so the same text twice still arrives.

**Twin path.** A cold start's launch URL goes through `dispatchLaunchUrl` on the frontend, so `captureLinkPayload` repeats the Rust decoding (`decodeURIComponent` throws on the same malformed input). The mock answers `getCurrent()` from `localStorage['__mockLaunchUrl']` so the e2e spec can stand in for the OS launching the app by a link.

**Tests.** Rust: percent and `+` decoding, UTF-8 and newlines kept, unknown and repeated parameters, no `text` opens empty, malformed escapes and the cap. vitest: the dialog merges a second link below typed text; the hook opens the dialog for the event and the launch URL, refuses over the cap. `e2e/capture-deep-link.spec.ts`: Escape saves nothing; *Capture* saves into today's journal, re-queried after navigating away and back; a launch link opens the dialog once booted.

**Falsified.** Replacing typed text with the link's reddens the merge test; breaking the launch-URL branch reddens the nine hook tests.

**Ran.** vitest (dialog, hook, `App`, router), typecheck, lint, the Playwright spec, the deep-link Rust tests, clippy.
