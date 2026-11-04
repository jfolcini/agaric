# Session 3398 — search indexes block text as the editor shows it

#6277 item B3. The FTS strip decoded only four escapes, after the markup
pass, so `arr\[0\]` and `\_\_init\_\_` were unfindable by what the user sees,
and `\*a\*` indexed as `\a\`. A `((ULID))` block ref indexed as its raw id.

The strip now runs one left-to-right pass first, in the editor's order:
- code: a backtick run closes on the same line for a span, on any later
  line for a fence, and its text is indexed raw;
- escapes: the full `isEscapableChar` set is decoded;
- block refs: `((ULID))` becomes its target's whole first line.

Each span becomes a placeholder that later passes cannot touch, and the
spans are restored at the end. Titles come from one `json_each` lookup of
just the ids a batch names. The mock's `stripForFts` and the oracle fold
follow the same rules; the mock imports the editor's `isEscapableChar`.

A content edit now enqueues `ReindexFtsReferences`, and so does a
recovered draft, so a block ref's referrers re-strip when its target
changes. The inbound-sync selector also takes changed blocks that a link
row targets.

The maintainer was asked three questions on #6277, with no answer yet. The
build follows the stated defaults: a soft-deleted target keeps its title, a
purged one is `""`, and the first line is indexed uncapped.

The reviewer found three things, fixed here:
- inline code spans paired across lines, unlike `scanCodeSpan`;
- dropping `\t` or punctuation from the Rust escape set reddened nothing;
- a recovered draft did not re-strip its target's referrers.

Its 300k-input differential found Rust and the mock identical on every B3
construct.

Ran: the B3 Rust, vitest and Playwright tests, each red first; the
mutations in the PR body; the full workspace nextest and vitest (reviewer);
clippy; prek. The `e2e-tauri` spec has not run here (no tauri-driver), so
CI's lane is its first run. The Rust-authored `fts` field on
`block-content.vectors.json` waits for #6304.
