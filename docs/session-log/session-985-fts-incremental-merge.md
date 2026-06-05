## Session 985 — FTS periodic maintenance: bounded incremental merge, not full optimize (#422) (2026-06-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-05 |
| **Items closed** | `#422` |
| **Dimension** | performance (scaling; medium) |
| **Tests** | existing `fts::` suite (245 passed) |
| **Files touched** | 1 + `.sqlx` (−1/+1) |
| **Schema / wire-format** | none |

**Summary:** the periodic `FtsOptimize` background task ran the FTS5 full-merge
`INSERT INTO fts_blocks(fts_blocks) VALUES('optimize')`, which rewrites the
ENTIRE trigram index into a single segment — `O(total index size)` while holding
the writer lock on the 2-connection write pool. It is enqueued on a threshold of
`max(500, block_count/10000)` edits or hourly, so a moderately active large vault
pays a full-index merge periodically.

Fix: switch the periodic task to FTS5's **bounded incremental merge**,
`INSERT INTO fts_blocks(fts_blocks, rank) VALUES('merge', N)`, which processes at
most `N` pages (`FTS_MERGE_PAGES = 256`) per run and returns — a FIXED maintenance
cost regardless of index size. Steady-state fragmentation is already bounded by
FTS5 `automerge` (default 16, merges on every insert), so this periodic merge is
supplementary cleanup; a full `'optimize'` is reserved for an explicit
user-initiated maintenance action (not the automatic cadence).

`FTS_MERGE_PAGES` is a work-budget knob, not a correctness threshold — any
positive value is correct and only tunes per-run merge aggressiveness; 256 pages
is a modest chunk suited to mobile flash + the 2-connection write pool.

**Files touched:**
- `fts/index.rs` — `fts_optimize` body → `('merge', FTS_MERGE_PAGES)` + rationale doc + the new const.
- `src-tauri/.sqlx` — removed the orphaned `('optimize')` query entry, added the new `('merge', ?)` entry (regenerated; only the one swap).

**Verification:**
- `cargo nextest run fts::` → **245 passed**, incl. `fts_optimize_succeeds_and_search_still_works` (the bounded merge runs and search still works). `SQLX_OFFLINE=true` build clean (CI offline `.sqlx` satisfied). clippy + rustfmt clean.

**Commit plan:** single commit (incl. the `.sqlx` swap); branched off `main`; PR against `main`.
