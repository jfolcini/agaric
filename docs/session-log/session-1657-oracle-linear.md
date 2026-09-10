# Session 1657 — the integrity check was superlinear in the vault

Settings → Data → **Run check** rebuilds every derived table from base tables
and diffs the result. Its cost had never been measured. Two shapes in it were
superlinear in the vault rather than in the number of divergences, and the
sweep read `blocks` — every row, `content` included — about a dozen times.

The person paying for that is the one with a large vault, clicking a button in
a dialog they opened *because something is already broken*, with Copy report
and Open GitHub issue disabled the whole time.

## The number #4900 did not have

Synthetic vault: 1000 pages × 100 blocks = 101,001 `blocks` rows, 104,000
`block_properties`, 100,000 `block_links`, 2,000 dated repeating blocks. One
16-core box, 28 GB.

| build | projected rebuild | counts rebuild | `reconcile_all` |
|---|---|---|---|
| debug, before | 17.8 s | 66.2 s | **316.8 s** |
| debug, after | 0.46 s | 0.46 s | **8.3 s** |
| release, after | 0.24 s | 0.17 s | **2.4 s** |

The debug rows are a clean same-build A/B. The release BEFORE figures are not
quoted as a pair: that run followed its own LTO build with the box swapping at
load ~19, so 25 s is the honest floor there rather than a measurement, and the
AFTER binary overwrote the BEFORE one at the same artifact path. Two more
nine-minute LTO builds on a machine the maintainer is using was not worth the
tidier table.

## What changed

- `reconcile_all` dumps `blocks` once and threads the slice. `reconcile`, the
  six `reconcile_*` and the `rebuild_*_from_base` functions take
  `blocks: &[BaseBlock]`.
- `fold_projected_agenda_from_base`'s `prop` closure scanned the whole
  `block_properties` dump and ran four times per dated block — 2000 dated
  blocks against 100K property rows is ~800M string comparisons on a tokio
  worker. It builds the index once now, the shape
  `fold_agenda_cache_from_base` two functions above already used.
- `rebuild_pages_cache_counts_from_base` was O(pages × (blocks + links)). One
  pass over blocks and one over links grouped by page: 14.7 s → 0.17 s in
  release. The restructure came out the same length, so it was worth taking.

## Snapshot isolation: the note, not the claim

Threading one dump does NOT give the sweep a consistent read. `block_links`,
`block_properties`, `block_tags`, `attachments` and every derived table are
still separate autocommit reads, so a concurrent edit can still produce a
phantom divergence. `reconcile_all`'s docs say so and name a read transaction
as the fix.

`a_write_after_the_blocks_dump_still_reads_as_a_divergence_4901` pins that the
gap is real rather than leaving it as prose: a block inserted after the dump
and settled yields exactly `pages_cache.child_block_count [A] 2→3` and
`fts_blocks.row [LATE]` from the stale slice, and a clean fresh run afterwards.

Taking the note over the claim matters here. A performance change that
silently narrowed what the check reports would be worse than the slowness.

## Equivalence

`reconcile_all_reports_every_artefact_from_one_unfiltered_dump_4901` asserts
the exact ordered 20-entry `(artefact, key)` list on a fixture that diverges in
every artefact. It was run green against the UNCHANGED code first — which
caught one row that had been predicted wrong (`repeat-until` is a dated
property, so agenda arm 0 promotes it too) — and is green after.

Three mutations on a copy, each restored `cmp`-identical, each red:

1. a live-only slice threaded → `blocks.page_id` for the tombstoned block
   disappears from the report;
2. the counts fold keeps same-page sources → a phantom
   `pages_cache.inbound_link_count` appears;
3. the property index ignores the key → the projected rows differ.

## Verification

Full workspace on a quiet box: **6334 tests, all passing** — the five that
timed out during the build were load artifacts at load ~85 and pass in
isolation. `cargo clippy --workspace --all-targets -- -D warnings` clean. No
`query!` was touched, so no `.sqlx` regeneration is owed.

The scale sweep is `#[ignore]`d and leashed in `.config/nextest.toml`, the
shape the 4241/4242 residency sweeps already use: it is the number, not the
gate. Equivalence is what gates per PR.

Closes #4901.
