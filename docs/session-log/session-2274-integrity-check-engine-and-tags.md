# Session 2274 — The integrity check audits tag inheritance and the Loro engine

#5628 had three gaps in the Settings integrity check (`reconcile_all`):
`block_tag_inherited` was never audited, the Loro engine was never compared
with SQL, and the check's report-only stance was never decided. Since #5418's
snapshot pass advances the apply cursor, boot replay no longer heals a write
that took the SQL-only fallback or a skipped engine fan-out. That makes this
check the place such drift shows.

**Gap 1.** `block_tag_inherited` is rebuilt by the oracle with the production
walk, depth bound and nearest-ancestor rule, then diffed. A stale row and a
missing row are both named.

**Gap 2.** Each space's doc is exported under the engine lock, only long
enough to clone the handle, and read in a throwaway engine. Block rows,
sibling order and the engine-held properties and aliases are compared with
SQL. Sibling order is compared by each block's place among the siblings both
sides hold, not by raw rank. The first vault run showed why: every one of 234
position reports was a gap a purge leaves in SQL ranks, with order unchanged.
Readers sort by `(position, id)`, so a gap harms nobody. Soft-deleted rows,
space-less blocks, detached nested pages and tombstones the engine keeps all
read as agreement.

**Gap 3.** The check stays report-only, as the issue leaned. Drift remains
visible as a defect instead of being repaired away.

**What it found.** On a copy of the maintainer's vault, the check found one
real divergence: a live block missing from Work's engine. The block was
pinned by #5670, whose diagnosis traced it to the pre-#5418 boot replay that
#5630 also fixed. #5670 adds a targeted one-shot repair for vaults already in
that state.

**Stale claims.** Every comment and doc that said boot replay reconciles
these writes is corrected. That covers the apply kernel, the SQL-only
fallback, the materializer handlers, `loro_sync.rs`'s tombstone fan-out,
history, metrics, `sql-only-convergence.md` and `crdt-and-recovery.md`.
Review caught four more, plus a bug-report string that counted the
artefacts. That count would have rotted, so it is gone.

**Tests.**
- Eight engine checks and the tag-inheritance diff were each shown red at
  their predicted assertion.
- The sibling-order pair: a reorder names both swapped blocks, and a gap
  that keeps order names none. Comparing raw ranks reds the gap case;
  sorting SQL by engine rank reds the reorder case.

Gates: full workspace nextest in two partitions (builder), targeted 74/74
after review, clippy, `SQLX_OFFLINE=true cargo check`, fmt, `npm run
typecheck`, and the bug-report and settings vitest files.
