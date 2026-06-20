# Session 1106 — /batch-issues loop: reduce oxlint-disable directives, tractable slice (#1502)

Partial progress on #1502 (reduce the 243 load-bearing oxlint-disable directives by fixing
the underlying code). This pass did the tractable `typescript/no-non-null-assertion` slice:
removed 8 of 19 directives by replacing `x!` with explicit guards / optional chaining /
definite-assignment (behavior-preserving), in files NOT under concurrent cluster change.
1 left as a genuine TS footgun (guard narrows to `never`); 10 left in editor-adjacent hot
files to avoid merge conflicts with the in-flight Markdown cluster. The architectural 118
`jsx-a11y/prefer-tag-over-role` + the intentional `exhaustive-deps`/`complexity` remain
(tracked by #1502). tsc + oxlint clean; 101 + 251 tests pass.
