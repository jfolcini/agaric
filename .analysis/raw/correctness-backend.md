# Correctness — Backend (Rust) Analysis

**Summary**: The Rust backend's correctness-critical surfaces are unusually well-hardened
(linear hash-chained op-log append, cursor pagination with versioned cursors and loud
limit rejection, cohort-keyed soft-delete/restore cascades bounded at depth<100, sticky
month-end recurrence clamp with documented Org-mode semantics, native-typed engine-apply
mirroring). The engine_apply dispatcher exactly mirrors the in-tx via-loro routing and
emits a durable divergence counter for swallowed post-commit fan-out failures. Most of the
obvious correctness classes are already guarded or pinned by tests. Three genuine but
narrow issues surfaced, plus several "looked suspicious, is actually fine" non-findings.

**Counts**: CRITICAL 0 · HIGH 0 · MEDIUM 2 · LOW 1

---

### [MEDIUM] Restore of a non-root deleted block can create a live orphan under a still-deleted parent
- **Location**: src-tauri/src/commands/blocks/crud.rs:1037-1083 (`restore_block_inner`); related: src-tauri/src/loro/projection.rs:491-525 (`project_restore_block_to_sql`), src-tauri/src/soft_delete/restore.rs:73-82
- **Evidence**: `restore_block` is a public Tauri command (`commands/mod.rs:79`) taking an
  arbitrary `block_id`. `restore_block_inner` validates only that the block exists, is
  deleted, and that `deleted_at` matches `deleted_at_ref` (lines 1041-1059). It then clears
  `deleted_at` on the seed and its same-cohort *descendants* (the recursive CTE walks
  downward only). There is no check that the block's **parent** (ancestor chain) is live.
- **Problem**: If a user/agent restores a deeply-nested block whose ancestor remains deleted
  (e.g. the ancestor was deleted in a *different* cascade/cohort, or the caller passes a
  descendant id directly), the restored block ends up with `deleted_at IS NULL` while its
  `parent_id` points at a block with `deleted_at IS NOT NULL`.
- **Impact**: An orphaned live block that is invisible in the normal tree (`list_children`
  filters `deleted_at IS NULL`, so it won't render under its deleted parent) and absent from
  trash (its own `deleted_at` is NULL). The subtree invariant "a live block's ancestors are
  live" is broken. Reachability depends on the FE only ever offering trash-*root* restore;
  the backend command itself does not enforce it, and the op-replay/sql_only projection path
  (`project_restore_block_to_sql`) has the same shape, so a synced `RestoreBlock` op for a
  descendant id would reproduce it on every device.
- **Fix**: In `restore_block_inner` (and mirror in the projection path), after resolving the
  seed, verify the seed's parent chain is live — either reject with `InvalidOperation` if any
  ancestor is still soft-deleted, or restore upward to the nearest live ancestor. At minimum,
  add a `tracing::warn!` breadcrumb when the restored seed's `parent_id` resolves to a
  `deleted_at IS NOT NULL` row.
- **Confidence**: medium — the missing guard is real and verified; the user-facing impact
  hinges on whether any caller (FE or MCP) actually passes a non-root descendant id, which I
  did not exhaustively trace through the frontend.
- **Effort**: M

### [MEDIUM] FTS rank keyset uses an epsilon band that disagrees with the exact `ORDER BY`, so rows with near-equal (but unequal) rank can be skipped
- **Location**: src-tauri/src/fts/search/fetch.rs:150-152 and :265 (ORDER BY); related: src-tauri/src/fts/search/cursor.rs:16-25
- **Evidence**: The keyset WHERE admits a row when
  `fts.rank > ?3 + (1e-9*MAX(1,ABS(?3)))  OR  (ABS(fts.rank-?3) <= 1e-9*MAX(1,ABS(?3)) AND b.id > ?4)`,
  but the page ordering is the **exact** `ORDER BY fts.rank, b.id` (line 265) — no epsilon.
- **Problem**: Consider a row whose `rank` is strictly greater than the cursor rank `X` but
  within the relative epsilon band (`X < rank <= X+eps`). By the exact ORDER BY it sorts
  *after* the cursor row, so it belongs on a later page. But the WHERE evaluates clause 1
  (`rank > X+eps`) false and clause 2 requires `id > cursor_id`; if that row's `id <= cursor_id`
  it satisfies neither clause and is dropped from the resumed page entirely. Symmetrically a
  row in `[X-eps, X)` with `id > cursor_id` could be returned twice. The cursor doc claims
  "equal-rank rows are always disambiguated by the unique block_id", but the band silently
  re-groups *unequal* near-equal ranks under the id tiebreaker while the sort does not.
- **Impact**: A result can be silently skipped (or duplicated) across a page boundary when
  two FTS5/bm25 results have ranks within ~1e-9 relative. With bm25 scoring this is rare
  (distinct documents almost always differ by more than 1e-9), so real-world loss is unlikely
  but possible for near-identical-content blocks. Pure correctness edge, not a panic/crash.
- **Fix**: Make the comparison consistent end-to-end. Either drop the epsilon and rely on the
  exact `(rank, id)` keyset (re-deriving rank deterministically), or make the ORDER BY rank
  comparison agree with the band (e.g. snap rank to a quantized key used by both WHERE and
  ORDER BY). The current half-and-half (exact sort, fuzzy WHERE) is the inconsistency.
- **Confidence**: medium — the logical gap is verified against the SQL; impact is bounded by
  how often bm25 produces ranks within 1e-9, which I did not measure. The epsilon (#1598) was
  added deliberately to absorb float drift, so this is a trade-off the authors made — flagging
  the residual ordering inconsistency, not the epsilon decision itself.
- **Effort**: M

### [LOW] Unchecked `n * 7` multiply in the weekly recurrence shift (debug panic / release wrap on pathological input)
- **Location**: src-tauri/src/recurrence/parser.rs:113
- **Evidence**: In `shift_date_once`, the `"w"` arm is `base + chrono::Duration::days(n * 7)`
  while the sibling `"m"`/`"y"` arms use checked arithmetic (`shift_by_months(base, n)?` and
  `n.checked_mul(12)?`). `n` is parsed from the user/imported recurrence string
  (`num_str.parse::<i64>().ok()?`, line 103) and only guarded `n > 0` (line 108) — it is not
  bounded above.
- **Problem**: For `n` near `i64::MAX/7` (an ~18-digit count, e.g. `+1329227995784915872w`),
  `n * 7` overflows: debug builds panic, release builds wrap to a nonsensical (possibly
  negative) day delta. The `m`/`y` arms already protect against this; the `w` arm is the lone
  unchecked multiply.
- **Impact**: Only reachable via an absurd recurrence interval string (hand-typed or
  imported). Worst case a debug-build panic or a silently-wrong shifted date in release. Very
  narrow, but it's a free, asymmetric inconsistency with the adjacent arms.
- **Fix**: `"w" => base + chrono::Duration::days(n.checked_mul(7)?)` (return `None` on
  overflow, matching the `m`/`y` arms), or cap `n` at parse time.
- **Confidence**: high — directly verified the unchecked multiply and the asymmetry with the
  checked `m`/`y` arms.
- **Effort**: S

---

## Non-findings (areas checked, deliberately NOT flagged)

- **engine_apply dispatcher** (merge/mod.rs:53-207): routes new-scheme `index`/`new_index`
  vs legacy `position`/`new_position` exactly as the in-tx via-loro path; SetProperty stores
  native-typed values; post-commit fan-out failures bump a durable divergence counter
  (merge/divergence.rs). Correct.
- **Cursor codec** (pagination/mod.rs:522-592): versioned, rejects unsupported versions,
  rejects malformed version field, treats missing version as v1. `index_to_provisional_position`
  saturates strictly below `NULL_POSITION_SENTINEL`. `position_keyset_binds` /
  `split_position_keyset_page` are the single source of truth for the `(position,id)` keyset.
  No off-by-one in has_more/truncate. Correct.
- **PageRequest::new** (pagination/mod.rs:720-736): loud rejection of out-of-range limits (no
  silent clamp), per invariant. Correct.
- **Soft-delete cascade** (soft_delete/trash.rs:84-99): recursive CTE filters
  `b.deleted_at IS NULL`, bounds `depth < 100`, stamps a single monotonic `next_delete_ms()`
  across the cohort. Restore uses `descendants_cte_cohort!` keyed on structural cohort
  contiguity (not flat `deleted_at =` equality), avoiding over-restore of independently
  deleted descendants (#1119). Correct (aside from the orphan-parent gap above).
- **Recurrence month-end clamp** (parser.rs:74-93, shift_by_months 39-57): "sticky" clamp is
  intentional Org-mode semantics, pinned by a chain test; leap-day handling (Feb-29→Feb-28)
  via `day.min(max_day)` is correct; `+Nm`/`+Ny` use checked i64 month arithmetic with a
  1900..=2200 guard rail. `days_in_month`'s `pred_opt().unwrap()` is only ever reached for a
  real first-of-month date and the `year+1` overflow is gated by the calendar-year bound.
  Correct (except the `w` arm above).
- **Recurrence repeat-count termination** (compute.rs:209-221, 387-388): `current_seq >= max_count`
  with 0-indexed seq produces exactly `repeat-count` siblings. Correct.
- **op_log append** (op_log/append.rs:124-270): `BEGIN IMMEDIATE`-contracted (lint-enforced),
  `COALESCE(MAX(seq),0)+1` under the write lock, ULID uppercase normalization before hashing,
  origin/is_undo excluded from the hash preimage (correct — local metadata, must hash-match
  cross-device). Correct.
- **tag_inheritance remove/propagate** (tag_inheritance/incremental.rs:25-90+): three-step
  re-attribution (in-subtree taggers + ancestors-above) handles nested-tagger and
  grandparent-fallback cases (#675). Intricate but consistent with documented intent;
  no concrete defect found in the read region.

## Areas reviewed / not reviewed
- **Reviewed (read focused regions)**: merge/{mod,apply,divergence}.rs; pagination/mod.rs
  (cursor codec, keyset helpers, PageRequest); fts/search/{fetch,cursor}.rs (rank keyset);
  recurrence/{parser,compute}.rs (date math, termination); soft_delete/{trash,restore,mod}
  + restore projection in loro/projection.rs; commands/blocks/crud.rs (restore_block_inner,
  edit resurrection guard); op_log/append.rs; tag_inheritance/incremental.rs (partial).
- **NOT reviewed in depth** (time budget; flagged for a follow-up pass): loro/projection.rs
  (144k — only the restore/property/tag projectors read), loro/engine/* internals (LWW /
  move-as-CRDT resolution at the LoroDoc level), materializer/{dispatch,coordinator,
  retry_queue}.rs replay/rederive correctness, snapshot/{create,restore,codec}.rs round-trip,
  query/engine.rs + tag_query/query.rs (large query builders), backlink/{filters,grouped}.rs
  group-cursor edge cases, reverse/{batch,block_ops,property_ops}.rs inverse-op correctness.
  The DAG module (`dag/`) is tests-only at this commit (parent_seqs is linear Phase 1 per
  append.rs), so multi-parent merge convergence was out of scope.
