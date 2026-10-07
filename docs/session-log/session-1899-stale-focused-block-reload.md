# Session 1899 — a peer's edit to the parked block shows once you leave it (#5278)

This is another `/batch-issues` batch from the session that logged 1877. It was
built while #5319 (#5286) waited on CI.

## #5278

- **The bug.** A sync reload keeps the focused block's store text, so a
  peer's edit does not flash over the editor. #2600 accepted last-writer-wins
  while the user is editing, but the kept copy outlived that session.
  - Leaving the block without typing wrote nothing and reloaded nothing. The
    block went on showing the old text.
  - The next edit then mounted the old text, and its full-text save reverted
    the peer's edit on both devices.
- **The fix.**
  - `load()` records `staleFocusedBlock`, the id and the text it kept, when
    the fresh text differs. Every load recomputes it.
  - `BlockTree`'s focus-change effect reloads the store once when focus
    leaves that block and the store still holds the kept text. Every way of
    leaving a block passes through that effect: a blur, arrow keys or a click
    elsewhere.
  - If the user typed, the store already holds the new text. The edit's own
    save wins, as #2600 accepted.
  - The reload replaces that block's empty-block cleanup. The store's copy is
    stale, so its emptiness is no evidence.

## Verified

- New tests, each turned red by a mutation run against a copy, then restored:
  - the store records the kept copy, and records none when the focused block
    matches the backend;
  - leaving the block untouched reloads it to the peer's text;
  - leaving it after typing keeps the typed text.
- Mutations: no reload; reloading without the typed check; never recording;
  recording when the texts match.
- `vitest related` over the three changed modules: 133 files, 4462 tests pass.
- `npm run typecheck` and type-aware oxlint pass.
