# Session 4115 — a key right after a caret key acts on the moved caret, in blocks and in page mode

The follow-up to #6725 (session 4100). That session's log says the second route to a mid-word split, the one found in Chromium, was "left alone": nobody had reported it and the fix reads a ProseMirror internal. The orchestrating session asked for that claim to be checked and the product fixed if the fix was small and safe. It is, and this is it. #6725 was approved and green when the note arrived, so it merged as it stood and this is its own PR.

## The bug

End, Home and the arrows move the caret in the DOM, and ProseMirror takes that in on `selectionchange`, a task later. A key handled before that task acts on the caret from before the move: the key rules read `editor.state.selection`.

- At a driver's speed, with nothing between End and Enter, Enter split at the old caret 12 of 20 times on the mock in Chromium. Idle, `selectionchange` arrived 10 to 25 ms after End's keydown, and a 50 ms gap passed 10 of 10.
- At a person's speed, with the two keys 60 to 80 ms apart inside a 150 to 300 ms main-thread stall, it split wrong 10 of 10: a busy page handles the queued keys back to back, ahead of the queued event.
- Home then Backspace did not merge, and page mode's Enter split at the old caret, the same way.

## The fix

`readDomSelection` (`src/editor/read-dom-selection.ts`) has ProseMirror read the DOM selection at keydown, before any rule reads the caret. It calls `view.domObserver.flush()`, which is what ProseMirror's own `selectionchange` handler calls, so it is the read that would have happened a task later. Block mode calls it in `useBlockKeyboard`'s capture handler, after the IME guard; page mode in `PageKeys`' `handleDOMEvents.keydown`, which runs before the keymaps, with the same guard: ProseMirror holds its own reads back during a composition.

`domObserver` is a ProseMirror internal with no type. If an upgrade renames it the call does nothing, and `e2e/enter-after-caret-key.spec.ts` goes red.

This does not cover what failed in CI on #6713. There ProseMirror's post-focus timer had already put the DOM caret back, so a read at Enter's keydown reads the click point; #6725's helper change is what fixed that.

## Tests

- `e2e/enter-after-caret-key.spec.ts` holds the main thread while it presses two keys, so the page handles them with no task between: End then Enter and Home then Backspace in block mode, End then Enter in page mode, each read back after leaving the page or from the backend. Before the fix the block-mode pair was red 20 of 20 and page mode 5 of 5.
- `use-block-keyboard.test.ts` and `page-keys.test.ts` move the DOM caret with `selectionchange` held back and press a key. Each was shown red by removing its call, and each IME test by dropping its guard.

## Traps

- **For 200 ms after a focus ProseMirror takes a collapsed caret at the document's start for the browser's focus reset** and puts its own back (`DOMObserver.flush`). Home in a one-paragraph block lands there. The spec's stall is longer than that, and the unit tests put the DOM caret mid-text.
- **jsdom sends `selectionchange` inside `Selection.collapse`**, so ProseMirror has read a moved caret before a test can press a key. The unit tests stop the event at `window` in the capture phase for that one call.
- **A full vitest run that overlaps a falsification reads the mutated file.** One was started before the mutations and thrown away.
- **`diagram-legibility` and `diagram-scrollbar` fail in the cloud container on a clean `origin/main` bundle too**, four tests; `docs/BUILD.md` names the first and not the second.

## What ran

On this tree: full vitest (1111 files, all green), `npm run typecheck`, `npm run lint`, `npx knip`, and `e2e/enter-after-caret-key.spec.ts` ten times each, 30 of 30.

On the same change before `main` moved under it: the 1184 `@editor` Playwright tests, 1173 green, 7 skipped and the four diagram tests above red; and, on a desktop build with the fix, the real-backend `block-structure-roundtrip.e2e.ts` 5 of 5 and the 34 spec files that go through `enterBlankSibling`, `editAtEnd` or `caretToEnd` 33 of 34. The one red there, `sync-two-device` › "Settings shows this device's sync address", is the container's network: its only interface is `192.0.2.2`, which the app passes over, and it was red the same way before this change. No `src-tauri/` change, so no Rust gates.
