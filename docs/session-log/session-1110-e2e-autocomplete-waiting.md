# Session 1110 — /batch-issues loop: fix e2e autocomplete spec after WAITING removal (2026-06-20)

The WAITING task-state removal (#1861) updated the `src/` unit tests but missed
`e2e/autocomplete.spec.ts:34`, which asserts the `state:` autocomplete popover offers
`['TODO','DOING','DONE','WAITING','CANCELLED','none']`. With WAITING removed, the e2e
`getByTestId('autocomplete-item-WAITING')` assertion fails — so MAIN's `playwright (1)`
shard broke, failing every open PR that rebased onto it (#1865/#1866/#1867).

Fix: drop `'WAITING'` from the expected list in the spec → `['TODO','DOING','DONE',
'CANCELLED','none']`, matching the now-fixed `STATE_VALUES`. `grep WAITING e2e/` is clean.

Lesson: when removing a vocabulary value, grep `e2e/` too — not just `src/` (the WAITING
builder's grep was `src/`-only).
