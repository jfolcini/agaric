# Session 4085 — Double click on a marked word, the App Links claim, and the compaction spec shown red

One PR for three small items from #6694, #6555 and #6518.

## #6694: a double click near the start of a marked word

With "Show Markdown syntax around the cursor" on, the first click of a double click draws the markers of the run it lands in, and the text moves. The second press lands on a marker (the browser selects nothing) or on another word. `markdown-reveal.ts` now remembers, at the first press, the character under the pointer, the document and what was drawn; at the second press (`event.detail === 2`), if what is drawn changed, it selects the word that character is in and stops the browser's own handling. The word comes from `Intl.Segmenter`; a space, punctuation or a chip under the first press leaves the double click to the browser.

The roving editor keeps one plugin instance across blocks, so a first press remembered in one block's document would be read against another's. The press records its `doc`, and a second press in a different document is left alone.

A double click that draws nothing new is left to the browser.

Block mode uses the same plugin and gets the same fix inside a focused block; only page mode has a spec.

## #6555: the App Links claim

`agaric.app` is not registered. The `mobile` block of `plugins.deep-link` is deleted, so the Android build injects no `autoVerify` filter (the plugin's `build.rs` writes one filter per `mobile` entry, and an empty block for none). No `https` link can reach the app any more, so the `https` arm is deleted from both routers (`deeplink/mod.rs`, `useDeepLinkRouter.ts`) with its tests; one test on each side pins that the old shape is now refused. Android opens no link at all until `agaric://` is registered there, which the maintainer queued on the issue and which needs a device; `agent-access.md` and `appearance.md` say so.

Not done: the issue's `aapt dump xmltree` of a release APK. No Android toolchain here.

Not taken: the Android share target, which needs a device to accept.

## #6518: the compaction spec, shown red

No code. `e2e-tauri/compaction-restart.e2e.ts` ran green here, then red with the `clamp_apply_cursor_to_surviving_max` call in `compact_op_log` skipped: `cursor: 23` where the spec expects `0`. That was the last open done-when of the issue.

The real-backend lane runs in a cloud session after `apt-get install webkit2gtk-driver openbox dbus-daemon` and `cargo binstall tauri-driver`.

## What ran

- vitest (full), `npm run typecheck`, `npm run lint`.
- Playwright: `page-mode-reveal`, `markdown-reveal`, `block-syntax-reveal`, `chip-reveal`, `deep-link`, `capture-deep-link`, `custom-css`, `page-kebab`. `tauri.conf.json` changed, so `e2e-related` selects both whole lanes: CI's run is the check.
- `cargo nextest run --workspace` in two halves, `SQLX_OFFLINE=true cargo check --workspace --all-targets`, clippy, `just gen-sqlx` and `just gen-bindings` (no diff).
- `just e2e-real` on `compaction-restart`, `page-mode-reveal` and `markdown-reveal-persist`.
- Reds: the new Playwright test against the old plugin (`double click on b`: `""` for `"bold"`); the router test against the old router; the Rust test with the scheme check widened to `https` (`expected WrongScheme, got UnknownHost("agaric.app")`).
