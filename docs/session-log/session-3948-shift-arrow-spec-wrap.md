# Session 3948 — Shift+ArrowUp spec no longer depends on line wrapping

`e2e/block-keyboard-fundamentals.spec.ts`, "Shift+ArrowUp at the start of a block does not switch
blocks", failed in CI on two unrelated PRs (#6630, #6631) with the editor still open where a block
selection was expected, and passed every local run.

Cause: the spec put the caret at the block's start with `Home`. `Home` goes to the start of the
visual line. The block's text is close to the page column's width, so with a wider fallback font
(the web font not loaded yet) it wraps to two lines, the click lands on the second, and `Home`
leaves the caret mid-block. Shift+ArrowUp then extends the text selection, which is the correct
behaviour before the edge (#910).

Shown by narrowing the viewport after the page opens so the block wraps: with `Home` the spec
fails with the CI error; with `Control+Home` it passes. The spec now uses `Control+Home`.

Checks run: the spec file on Playwright; `node --test scripts/e2e-related.test.mjs`.

Not explained by this: the one-off `e2e/token-chip-contrast.spec.ts` failure recorded on #6553.
