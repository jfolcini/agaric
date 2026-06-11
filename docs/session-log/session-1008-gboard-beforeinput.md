# Session 1008 — Gboard `beforeinput` fallback (#915)

Part of the overnight best-in-class UX pass (2026-06-11/12). The last of the 12 HIGH UX
findings (#909–#920).

## Shipped

- **#915 — Android Gboard (keyCode 229) block create/delete/merge.** `handleKeyDown` bails on
  `event.isComposing || event.keyCode === 229` before the KEY_RULES run. Gboard reports
  keyCode 229 for ordinary Enter/Backspace into a contenteditable without visible composition,
  so Enter→create, Backspace-empty→delete, and Backspace-at-start→merge never fired on Android
  (issue #728). Added a `beforeinput` listener on the editor DOM that maps the reliable
  semantic `inputType` independent of the keyCode quirk:
  - `insertParagraph` → `onEnterSave`
  - `deleteContentBackward` on an empty block → `onDeleteBlock`
  - `deleteContentBackward` at the start of a non-empty block → `onMergeWithPrev`
  - mid-text `deleteContentBackward` → no-op (ProseMirror deletes the char)
  Guards mirror keydown: bail on `isComposing`, defer while a suggestion popup is open, and
  defer inside code blocks / tables (#725).

## Why it doesn't double-fire on desktop

When `handleKeyDown` handles a key it calls `preventDefault()`, which suppresses the
subsequent `beforeinput`. So `beforeinput` only acts when keydown bailed (the Gboard path) or
for input the key rules intentionally don't own (mid-text backspace). Verified: the desktop
`block-keyboard-fundamentals` + `block-editing-text` e2e (7 specs) still pass with the listener
attached — no double block-create. Genuine IME composition produces `insertCompositionText` /
sets `isComposing`, never `insertParagraph`, so CJK input is unaffected.

## ⚠️ Needs on-device verification before merge

The fix is unit-tested (6 cases simulating `beforeinput` with each `inputType`) and proven not
to regress desktop, but the actual Android Gboard behaviour (does Gboard emit `insertParagraph`
/ `deleteContentBackward` with `isComposing === false`?) **cannot be exercised in this env** —
there is no Android device or soft-keyboard IME in jsdom/Playwright. This PR is flagged for
maintainer device verification and should NOT be auto-merged.
