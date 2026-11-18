# Session 4296 — the mirror keeps a file's lines while their render is unchanged (#6540 slice A)

Slice A of #6540, approved with the maintainer's answers relayed on the issue: the three-way splice, for every mirror.

The mirror's splice kept a file's own lines for a block only when they read as the block's render does. A block that reads as other text, as one another editor wrote, was rewritten into Agaric's form on the next write of its page, even when the write was for an unrelated change: another block edited, a linked page renamed. Adopting a folder in place (#6540) would rewrite such blocks of the user's files on the first unrelated write.

Now each text the mirror writes keeps the render it was written from (`Shadow::render`, stored with the page's state), and the next write splices against it as a base: a block's file lines, and the front matter, are kept while their render is what the base held, whatever they read as; only a block changed in Agaric since takes the render's lines. A state written before keeps no render and splices as before.

## What ran

- `cargo nextest run --workspace -E 'test(/mirror/)'`.
- The base check for blocks, for front matter, the relaxed read-back check (both halves), and the base passed by `try_write_page`, each falsified once: each reddened its own test.
- `cargo clippy --workspace --all-targets -- -D warnings`.
