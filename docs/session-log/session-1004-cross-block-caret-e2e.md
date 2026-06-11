# Session 1004 — Cross-block caret e2e coverage (#911)

Part of the overnight best-in-class UX pass (2026-06-11/12).

## Shipped

- **#911 — block-editing text/caret test coverage.** The review found no e2e asserted the
  TEXT outcome of keyboard editing or where the caret lands across blocks. Coverage now:
  - **Enter-split** — `e2e/block-keyboard-fundamentals.spec.ts` (shipped in #930): asserts
    the before-/after-caret text split.
  - **Cross-block caret landing** — new `e2e/block-editing-text.spec.ts`: ArrowDown at the
    end of a block lands focus on the *next* sibling (asserted by id, twice in sequence),
    not merely "a different block".
  - **Backspace-at-start merge text** — covered by the `handleMergeWithPrev` unit tests in
    `src/hooks/__tests__/useBlockKeyboardHandlers.test.ts`.

## Why no Backspace-merge e2e

The merge fires off ProseMirror's *internal* selection (`editor.state.selection.from <= 1`),
which can briefly lag the DOM selection an e2e can observe. Every caret-at-start precondition
reachable from outside the editor (Home, select-all+ArrowLeft, re-press-Home-until-offset-0)
proved non-deterministic — the merge fired ~⅓ of runs. A flaky test is worse than none, so
the merge keeps its unit coverage and the e2e is intentionally omitted (documented in the
spec header). ArrowUp/ArrowLeft-at-*start* navigation e2e is omitted for the same reason;
ArrowDown/ArrowRight-at-*end* (`End` reliably syncs PM's `to`) is deterministic and used.
