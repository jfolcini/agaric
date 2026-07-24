# Session 1225 — Purge-chain consolidation behind owner crates (#2895 slice 1)

**Issue:** #2895 (slice 1 of the consolidation plan)

## What

The app purge chain (`purge_subtree_tables` in `commands/block_cleanup.rs`) raw-wrote
12 owned tables. The statements moved 1:1 (byte-equivalent, reviewer-verified) behind
the owners, threading the caller's connection (no nested tx):

- `agaric_store::cache::purge_block_satellite_caches(conn, cte_prefix,
  member_subquery, bind)` — 11 satellite/cache DELETEs (block_tags,
  block_tag_inherited, block_properties incl. value_ref, block_links, agenda_cache,
  tags_cache, pages_cache, fts_blocks, page_aliases, projected_agenda_cache).
- `agaric_engine::block_ops::delete_blocks_in_subtree(conn, …)` — the final
  `DELETE FROM blocks`.
- App keeps orchestration + the 3 app-owned statements (attachments capture+delete,
  block_drafts — fs-backed/device-local, untracked by the ownership map).

## Review (adversarial, independent agent): SHIP, zero defects

The load-bearing question — statement ordering — proven safe: all three crud.rs
membership shapes (descendants CTE, flat deleted scan, json_each multi-root) resolve
ids by reading ONLY `blocks`, so the sole invariant is "everything before the blocks
DELETE", which is preserved (satellites → attachments → drafts → blocks last). The
minor reorder (fts/aliases/projected before attachments) touches tables absent from
every membership query. Tx integrity (no begin/commit in the new fns, same conn
reborrowed), AssertSqlSafe posture identical, no new interpolation sources.

## Baseline

Table-ownership: 6 app cache pairs ELIMINATED, app blocks 26→25 (rebased onto the
#3104 annotated baseline — annotations preserved through `--update-baseline`,
14 data pairs remain). Dynamic-sql baseline untouched (the counted invocation sites
stayed in the retained app helpers; the moved subcrate sites are outside that
guard's scope — #3107).

## Verification

`cargo check --workspace` clean; purge/conformance/delete nextest 361 passed
(post-rebase re-run 80 passed); store unit test for the new fn; clippy no warnings;
all six guard hooks pass.
