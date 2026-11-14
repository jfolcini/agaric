# Session 4100 — the real-backend helpers move the caret through the editor, not with End

`block-structure-roundtrip.e2e.ts` › "one Ctrl+Z takes back a split, and one a merge with the child it moved" failed once on #6713, a packaging-only PR: `enterBlankSibling` found the new block holding the tail of the text, `ght-<run id>`. The question was whether Enter splits at a stale offset (a product bug) or the helper sent its keys too soon.

## What it was

The test. Enter split where the caret was; the caret was not at the end because the helper's End had been undone.

- The spec opens the block with `row.click()`, the row's centre, and the caret goes where the click lands (#6562): 40 characters into the 56 here, which is the split point of the failure.
- The mount focuses the editor a frame later. On focus ProseMirror arms a 20 ms timer (`handlers.focus` in `prosemirror-view`) that writes its selection back to the DOM when the DOM selection is not the one it last observed.
- The helper pressed End about 20 ms after the focus. WebKit moved the caret at once and queued `selectionchange`; the timer ran first, took the moved caret for one the browser had made on focus, and put it back at the click point. Enter then split there, with the DOM and the editor agreeing on that caret.

Shown in the real app with a probe that logged every `Selection` write with its stack: in the mis-split round the write that put the caret back came from that timer, 4 ms after End's keydown and before its `selectionchange`. A second probe moved the caret 19 ms after focus, either as End does (`Selection.modify`, DOM only) or through the editor (`setTextSelection`): the DOM move was put back in 7 of 10 rounds, the editor's in none of 10.

A person would have to press End in the last few milliseconds of those 20, 50 to 130 ms after their click, and would then see the caret where they clicked, not a wrong split.

## What changed

`caretToEnd` in `e2e-tauri/helpers.ts` sets the selection through the editor, as `placeCaret` and other specs already do for other positions, and checks it in the same call. `enterBlankSibling` and `editAtEnd` use it in place of End. The twins, a click that opens a block followed by End or Ctrl+End: `due-date-agenda` (now `editAtEnd`, the same four lines), `block-edit-persist`, `block-line-break-persist`, and two places in `sync-two-device`. `e2e-tauri/AGENTS.md` has the rule. No product code changed.

## Found on the way, not changed

In Chromium on the mock, End then Enter with nothing between them mis-split 12 of 20 times with no latency at all, by another route: Enter is handled before `selectionchange` reaches ProseMirror, so `useBlockKeyboard` reads the editor's older selection while the DOM caret is at the end. Idle, `selectionchange` arrived 10 to 25 ms after End's keydown and a 50 ms gap passed 10 of 10. With the two keys 60 to 80 ms apart inside a 150 to 300 ms main-thread stall it mis-split 10 of 10: input is handled ahead of the queued event. So a person reaches it only when the page is stalled across both key presses. The rules in `useBlockKeyboard` read `editor.state.selection` the same way. A fix would read the DOM selection at keydown (ProseMirror's `domObserver.flush()`, an internal); nobody has reported it, so it is left alone and written down here.

## Traps

- **A local repeat count says little about this failure.** The window is the last few milliseconds of the 20 after focus, so it depends on how long the driver's calls take. A loop with the helper's own calls between the focus and End went 0 of 120 here, the first probe, with one call fewer, went 2 of 36, and CI hit it once in six runs. The probe that moves the caret inside the window is the evidence; the 15 green repeats are not.
- **The Tauri build embeds `dist/`, and so does Playwright's web server.** A mock-lane bundle built while the real-backend binary compiles goes to its own `--outDir`, served with `vite preview --outDir`, or the app embeds the mock.
- **The lane runs in a cloud container**: `apt-get install webkit2gtk-driver openbox xdotool`, `cargo install tauri-driver --locked`, then `scripts/e2e-tauri-local.sh <spec>`, which is what `just e2e-real` runs; one spec is about half a minute once built.

## What ran

Real-backend lane, locally, on the fix: `block-structure-roundtrip.e2e.ts` 15 times, 15 green. The 34 spec files that call `enterBlankSibling`, `editAtEnd` or `caretToEnd`, once: 33 green. `sync-two-device` failed one test, "Settings shows this device's sync address", which does not touch the caret: the container's only interface is `192.0.2.2`, which the app passes over as not a host address (its log says so), so there is no address to show. Its two tests that use `caretToEnd` passed. `npm run typecheck`, `npm run lint`, `npx vitest run e2e-tauri`, `node --test scripts/e2e-related.test.mjs`, `prek run --hook-stage manual --all-files`. No `src/` or `src-tauri/` change, so no full vitest and no Rust gates.
