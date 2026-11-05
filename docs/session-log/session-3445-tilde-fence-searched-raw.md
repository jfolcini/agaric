# Session 3445 — a tilde fence is searched as code

A follow-up to #6277 B3. The FTS strip read code from backtick runs only, so
a `~~~` fence kept its fence lines in the index, and a backtick fence line
inside it was read as a fence of its own. Content
`~~~md\n```js\nx\n```\n~~~` indexed as `~~~md\njs\nx\n\n~~~`. The mock did the
same, so the shared vectors agreed and stayed green.

The strip now reads a tilde fence the way `parseCodeBlock` does:
- it opens on a run of three or more `~` at the start of a line;
- it closes on a line holding only a run at least as long, plus whitespace;
- with no closer, it runs to the end.

Its body is indexed raw, like a backtick fence's. A `~~~` in the middle of a
line stays text. The mock's `stripForFts` mirrors this, and a vector row
pins the case, with its `fts` authored by Rust.

Ran: the B3 strip tables on both sides (red first, against the old strip),
the vector authoring and drift test, the `fts` and `strip` nextest filter,
clippy, and typecheck.
