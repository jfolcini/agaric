## Session 978 — batch the dense-rank reprojection into one guarded UPDATE (#419) (2026-06-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-05 |
| **Items closed** | `#419` |
| **Tests added** | +1 backend (batched ranks incl. tombstone + NULL-position + idempotency) |
| **Files touched** | 1 |
| **Schema / wire-format** | none (no migration; runtime `sqlx::query`, no `.sqlx` change) |

**Summary:** `reproject_dense_positions` (loro/projection.rs) rewrote a parent's
children to dense 1-based `position` with **one indexed single-row `UPDATE` per
sibling in a Rust for-loop** — N writer-locked round-trips inside the op tx,
every rank rewritten unconditionally even when unchanged. It runs after every
create and on both source+target parents of every move (handlers.rs
1603/1814/1816). The sibling list comes from `children_ordered_block_ids`,
which deliberately **includes soft-deleted tombstones** (they keep their slot
in the engine tree — soft-delete never calls `tree.delete`), so a long-lived,
churned parent (journal page, long list) accumulates dead siblings and every
later insert/move reissues an UPDATE for each live *and* dead sibling. The
tombstone tail is architecturally unbounded (no trash auto-purge, no group cap).

Fix: collapse the loop into a **single batched `UPDATE`** driven by a
`json_each` value list of `(id, rank)` pairs, with a `position IS NOT v.rank`
guard so only rows whose dense rank actually changed are written:

```sql
UPDATE blocks SET position = v.rank
FROM (SELECT json_extract(value,'$.id')   AS id,
             json_extract(value,'$.rank') AS rank
      FROM json_each(?1)) AS v
WHERE blocks.id = v.id AND blocks.position IS NOT v.rank
```

One writer-lock round-trip regardless of the tombstone tail; the `IS NOT` guard
makes the common case (rank already correct) a no-op write and still re-ranks a
row whose `position` was NULL. Behaviour is unchanged: the same ordered set
(tombstones included) gets the same dense 1-based ranks — only the number of
statements (N → 1) and the unchanged-row writes (N → 0) differ.

**Scope choices:**
- Kept the input set identical (tombstones included) — excluding soft-deleted
  siblings is a behaviour change to ordering semantics the issue marks as a
  separate "consider", so it is intentionally NOT done here.
- Used a runtime `sqlx::query` (not the `query!` macro) so the SQL change needs
  no `.sqlx` regen — same approach as #417's affected-page queries.
- `UPDATE … FROM (json_each …)` (SQLite ≥ 3.33, bundled by sqlx 0.9) gives a
  genuine O(N) join rather than an O(N²) correlated re-scan of the value list.

**Files touched:**
- `loro/projection.rs` — batched guarded UPDATE + updated cost doc; +1 test.

**Verification:**
- New `reproject_dense_positions_batches_group_incl_tombstone_and_null`: 4
  siblings (one soft-deleted tombstone keeping its slot, one with a NULL
  position) seeded out of order → dense ranks 1..4 in engine order; a second
  reprojection is a verified no-op (idempotent).
- `cargo nextest run loro:: materializer:: command_integration_tests::blocks
  commands::blocks` → **368 passed** (the create/move callers exercise it
  end-to-end). clippy + rustfmt clean.

**Commit plan:** single commit; branched off `main`; PR against `main`. Reconcile
PRs #446 (#417) / #447 (#421) once their CI (slow `build` job) is green.
