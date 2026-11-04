# Session 3292 — A voice-typing regression net

Slice S1 of #5745. OS voice typing (Gboard voice, macOS Dictation, Win+H)
reaches the webview as IME composition, so `e2e/voice-typing.spec.ts` drives
CDP `Input.imeSetComposition` and `Input.insertText` into every kind of field
and checks what was stored after navigating away and back: a block (plain
text, the end of bold, italic, code and a link, the end of a block, an empty
block), a phrase committed whole, a self-correction through the replacement
range, a composition still open when another block is clicked, the page title,
palette search, a `[[` picker query, the link popover and a property value,
and the end-of-bold case under a Pixel 7 user agent.

No case reddened on unmodified code, so no production change: #5724 had
already been closed as not a defect. Each case was shown red by breaking its
own commit path (for example, `handleTitleInput` rewriting `textContent`, the
palette query set late, `handleFocus` skipping the save while composing). The
`isComposing` / keyCode 229 guards in `use-block-keyboard.ts` cannot be reached
this way: CDP composition sends no key events.

A composition open when the roving editor moves is not ended under CDP
(`keepEditorUntilClick` prevents the press that would flush it), so ProseMirror
keeps `view.composing` set in the next block. Text still lands correctly. Real
platforms end the composition themselves (Gboard on a caret move, ProseMirror's
5 s Android timeout), so no issue was filed; the Android device pass confirms it.

WebKitWebDriver has no IME actions, so there is no `e2e-tauri/` composition
spec; the header says so.

Ran: the spec at `--workers=1` (17 passed, several runs) and
`--repeat-each=3 --workers=2` under load (51 passed), `npm run typecheck`,
oxlint, oxfmt, `node --test scripts/e2e-related.test.mjs`.
