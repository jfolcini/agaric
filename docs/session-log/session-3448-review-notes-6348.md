# Session 3448 — review notes from #6348

#6348's reviewer noted that a block holding only a tilde fence line (`~~~`
or `~~~md`, no newline) was indexed as its literal text. `parseCodeBlock`
shows it as an empty code block. Both strips, `tilde_fence` and the mock's
`tildeFence`, returned early when no newline followed the opening run.

They now fall through to the run-to-end case, as an unclosed fence does.
`~~~md` indexes as `md`, its info string, as a backtick fence's info string
already does, and `~~~` indexes as nothing.

Ran: the new strip-table row on each side, red first (the mock before the
fix, Rust with `strip.rs` at main); the `fts`, `strip` and vector nextest
filter; the vector re-author; the strip and conformance vitest; clippy;
typecheck.
