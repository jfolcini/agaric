# Session 1369 — The third interpreter: recovery's move arm joins #4112's rule (2026-08-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-22 |
| **Subagents** | one builder, one adversarial reviewer (no self-review) |
| **Items closed** | `#4187` |
| **Items modified** | `#4204`, `#4188` (measured and re-scoped; see their threads) |
| **Tests added** | +6 (backend) |
| **Files touched** | see PR #4233's file list |

**Summary:** #4112 closed the live-block-under-a-tombstone shape on the two **materializer**
replay arms. The **third** interpreter of the same op — `db::recovery.rs`'s `move_block`
arm, the DB-corruption rebuild that reconstructs `blocks` by replaying the whole `op_log` —
was deliberately left unswept. Reviewing that deferral: it was not safe, and it
reintroduced exactly the state #4112 exists to prevent.

The arm now runs a depth-100-bounded ancestor climb after its `UPDATE`; if the moved block
has a tombstoned ancestor, its whole live subtree is cascade-soft-deleted at **that
ancestor's own stored `deleted_at`**.

**Why it could not just call #4112's sweep.** Four independent blockers, all verified:
`sweep_move_under_tombstoned_ancestor` is `pub(crate)` in `agaric-engine` and not in the
app crate's shim; it is `i64` end-to-end (`nearest_tombstoned_ancestor` decodes an `i64`,
`project_delete_block_to_sql` binds one) while this pass runs **before** `sqlx::migrate!`
where pre-0080 `deleted_at` is rfc3339 TEXT (#618 — the same reason #2043 gives for the
delete arm staying inline); its tail runs `tag_inheritance::remove_subtree_inherited`
against a head-shaped `block_tags` recovery does not maintain; and — missed by the builder,
caught in review — its own subject probe is a `sqlx::query_scalar!` macro checked against
**head's** schema, which is the assumption a pre-migration pass must not make.

The two new statements are era-agnostic by construction: the probe returns only `a.id` and
tests `deleted_at IS NOT NULL`, and the cascade copies the ancestor's stored bytes via a
subquery. **No `deleted_at` value passes through Rust anywhere on this path** — strictly
better than the delete arm's era switch, which has to know which era it is in.

**Two blocking defects the review caught, both outside the SQL**

1. **`check-table-ownership` failed on this diff.** The cascade is a new cross-crate raw
   write to a table the app crate does not own: 12 → 13 against a baseline of 12. The
   builder re-anchored `dynamic-sql-baseline.txt` and never ran the sibling guard, which is
   a prek hook — it would have aborted the commit and CI. Re-anchored, plus the header
   prose that asserted "All 12 sites live in recovery.rs" and would have gone stale
   silently.
2. **Not rustfmt-clean** — one 101-column line against `max_width = 100`. The `cargo fmt`
   hook is `--check`, not auto-fix.

**The builder said one test could not be reddened. It can.**

`recover_move_under_a_live_parent_stays_live` was reported as un-falsifiable, on the
reasoning that an over-firing probe on a live parent writes `NULL` over `NULL` and is
invisible. That reasoning covered only the `deleted_at` assertions and forgot the
`ReplayDiagnostics` vector, which observes the **firing**, not the write. Flipping the
probe's `deleted_at IS NOT NULL` to `IS NULL` reddens it. It is load-bearing, not
decoration — and a claim that a test cannot fail is exactly the claim worth checking twice.

**A reach divergence, documented rather than hidden.** The engine's sweep cascades through
`DescendantWalkFilter::Active` — the walk *stops at* an already-tombstoned child and is
depth-unbounded. This cascade uses the standard walk (descends *through* a tombstoned
child) capped at 100. So for a live block beneath an already-tombstoned child of the moved
block, recovery stamps rows #4112 leaves live.

That is deliberate: recovery's own `delete_block` arm uses the standard walk with the same
cap, so adopting the engine's reach would make recovery disagree with **itself** —
`{Move(B→P), Delete(P)}` and `{Delete(P), Move(B→P)}` would stamp different row sets, which
is the replay-order divergence #4187 exists to remove. The comment records the trade
instead of claiming byte-identity with #4112. It is the same "reach, not the
skip-already-stamped filter" axis measured on #4204/#4188 this session, and closing it
needs both recovery arms changed together.

**A cycle test the arm did not have.** The arm carries no cycle probe by design (#2894), so
a corrupt op-log can close `A → B → A`. Added, and proved non-vacuous: relaxing the
recursive member's `a.depth < 100` to `100000000` makes it **time out**; it passes at 100.

**Verification:** `cargo nextest run --workspace` → 5970 passed, 7 skipped.
`cargo check --all-targets` clean. `check-dynamic-sql`, `check-raw-tx`,
`check-table-ownership` all exit 0 (the last was **1** before the fix).

Every falsification reproduced independently: sweep disabled → 3 RED; probe over-fires →
4 RED; seed guard dropped → 1 RED (the intended fence); depth bound relaxed → timeout.

**Baselines:** `dynamic-sql-baseline.txt` `42 → 44` for `recovery.rs` (recounted with the
guard's own scanner: ADDED 2, REMOVED 0, no grandfathered site un-marked);
`table-ownership-baseline.txt` `12 → 13` app/`blocks`.

**Commit plan:** single commit on `claude/sync-move-delete-convergence`, shipped as PR #4233.
