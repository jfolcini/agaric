# Session 1681 — block_links learns which kind of link it holds

#4551, first of three PRs. The editor has always drawn `[[ULID]]` page
links and `((ULID))` block references in different colours, and the
reindexer has always thrown that distinction away: `block_links` was
`(source_id, target_id)` with no discriminator, so every surface downstream
of it merged two things the user typed differently. The maintainer approved
the migration on 2026-09-10.

Migration 0119 adds `kind TEXT NOT NULL DEFAULT 'page_link' CHECK (kind IN
('page_link', 'block_ref'))` and backfills it from the token already in
content: a pair is a `block_ref` iff the source content carries the exact
`((<target>))` token. `ADD COLUMN`, not a rebuild, because the primary key
does not change and a pair stays one row; a block that carries both forms
to the same target is a `block_ref`, since the quotation is the claim a
filter will ask for. The default is the trade: an INSERT that forgets
`kind` lands `page_link` silently, so the reindexer test pins that
production INSERTs name it.

The rule lives in three places and a test compares two of them by
execution rather than transcription: the migration's `instr()`, Rust's
`classify_link_kind`, and the mock's `classifyLinkKind`. Both reindexer
variants build a target-to-kind map from the same regex pass, diff on
`(target, kind)`, and insert with `ON CONFLICT (source_id, target_id) DO
UPDATE SET kind`, so a pair whose kind changes on edit lands without a
delete. A second reindex over unchanged content writes nothing.

`kind` enters the conformance `page_links` projection on both runners; six
fixtures gained a `kind` line per row and nothing else, and the new
`block_ref_kind.json` pins `page_link`, `block_ref` and the both-forms rule
end to end. The mock dedupes its per-occurrence edges to one per pair in
the snapshot builder only; kind is a function of the whole content, so two
occurrences of one pair cannot disagree.

One `query!` text changed, so all four `.sqlx` caches swap one entry. The
ownership baseline is unchanged. The mock-contract baseline gained 0117 and
0118 alongside 0119; the script writes every migration on update and both
carry `-- mock-unaffected:`, so the lines change nothing.

## Verified

- `cargo nextest run --workspace -E 'test(/_0[0-9]{3}_/) | test(block_links) | test(conformance) | test(classify_link_kind)'`:
  194 passed (reviewer), 193 + 3 (builder, two filters).
- `cargo clippy --workspace --all-targets -- -D warnings` exit 0 (reviewer).
- vitest over `src/lib/tauri-mock`: 44 files, 869 passed, twice.
- `npm run typecheck` exit 0, twice; the migration-mock-contract, migration
  test-coverage and tauri-mock-parity guards exit 0.
- Falsified on copies, restored `cmp`-clean: the backfill probe matching
  `[[…]]` (A5a red); Rust reading the closing delimiter only (A5b red on the
  mixed-delimiter case); `DO UPDATE` dropped (both reindexer tests red); the
  mock classifier fixed to `page_link` (the new fixture and three parity
  cases red); the TS snapshot writing a constant kind (fixture red).
- Not run locally: the full suites (CI carries them; the laptop is in use).
