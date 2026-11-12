# Session 3950 — Shift+ArrowUp spec waits for the caret move to reach the editor

Second fix for `e2e/block-keyboard-fundamentals.spec.ts`, "Shift+ArrowUp at the start of a block
does not switch blocks". Session 3948 (#6632) replaced `Home` with `Control+Home` after showing that
a wrapped block breaks `Home`. That was a real hazard but not the failure seen in CI: the spec
failed again on #6633 with `Control+Home` in place.

Cause: `use-block-keyboard.ts` attaches its handler capture-phase and reads `editor.state`.
ProseMirror updates its state from the browser's caret only when `selectionchange` fires, which is a
later task than the key that moved the caret (its keydown `forceFlush` only runs a flush that was
already scheduled). So Shift+ArrowUp sent right after `Control+Home` sees the caret where the click
left it, `headAtStart` is false, and the key extends the text selection.

Shown by sending both keys in one `Promise.all`: 9 of 9 runs fail with the CI error. The spec now
arms a one-shot `selectionchange` listener before `Control+Home` and awaits it; the listener is
added after ProseMirror's, so it runs after the editor has read the selection.

Not changed: the product. A person cannot press two keys inside one task, so reading the live DOM
selection in the handler would be code for a case only a test produces.

Checks run: the spec 30 times, three workers; `node --test scripts/e2e-related.test.mjs`.
