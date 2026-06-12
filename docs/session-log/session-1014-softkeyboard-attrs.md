# Session 1014 — Soft-keyboard editor attributes (#925 finding 2)

Part of the overnight best-in-class UX pass (2026-06-11/12).

## Shipped

- **#925 finding 2 — deliberate soft-keyboard configuration.** The editor's contenteditable
  (`use-roving-editor.ts` `editorProps.attributes`) set only ARIA attributes, so mobile
  keyboards guessed the action key, capitalization, and autocorrect. Added deliberate choices
  for the prose-first block editor:
  - `enterkeyhint: 'enter'` — Enter creates a new block, so hint the keyboard's action key.
  - `autocapitalize: 'sentences'` — notes are prose.
  - `autocorrect: 'on'` + `spellcheck: 'true'` — prose typing aids.
  - `inputmode: 'text'` — explicit standard text keyboard.
  ARIA attributes (role/aria-multiline/aria-label) are preserved.

## Tests

Unit test asserts the contenteditable carries all five attributes (+ the ARIA ones). 2162
editor unit tests green; exact-text e2e (block-keyboard-fundamentals + block-editing-text, 7
specs) green — `autocapitalize` is a soft-keyboard hint and does NOT transform Playwright's
synthetic typing, so the exact-text assertions are unaffected; `tsc -b` clean.

## Caveat / deferred

The actual on-device keyboard behavior (action-key label, autocapitalize) needs a physical
device to confirm — the attributes are the fix and are unit-asserted. The other #925 findings
(formatting toolbar pinned-above-keyboard; BubbleMenu vs native Android selection handles) are
device-/visual-layout-dependent and deferred.
