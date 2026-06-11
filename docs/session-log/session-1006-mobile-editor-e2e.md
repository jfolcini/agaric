# Session 1006 — Mobile editor e2e coverage (#916)

Part of the overnight best-in-class UX pass (2026-06-11/12).

## Shipped

- **#916 — mobile/touch editor e2e.** No e2e exercised the editor on a mobile/touch
  viewport (the only mobile specs test Search). New `e2e/mobile-editor.spec.ts` runs the core
  note-taking surface on an iPhone 13 viewport (touch enabled): tap-to-focus + typing
  commits, Enter creates a block, ArrowDown moves focus across blocks. Drives the default
  boot (Journal) view, whose seeded day already has editable blocks.

## Scope note

Precise caret control via key chords does NOT behave identically under Playwright's
touch/mobile emulation — `Control+A` (select-all) and `End` do not move/select the way they
do on desktop, so typed text appends at the caret rather than replacing. The mobile specs
therefore assert the mobile-reachable contract (typing lands, a block is created, focus
moves) and leave exact Enter-split text assertions to the desktop
`block-keyboard-fundamentals.spec.ts`. Verified deterministic: 12/12 with
`--retries=0 --repeat-each=4`.
