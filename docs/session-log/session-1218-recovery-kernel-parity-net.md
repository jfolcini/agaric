# Session 1218 — Recovery↔kernel differential test net

**Issue:** #2894

## Problem

The meaning of an op-log record (what SQL rows + engine mutations it produces) is
re-implemented in 5 parallel interpreters kept aligned only by comments + isolated tests:
the canonical engine kernel `apply_op_tx`, the sql_only fallbacks, two hand-rolled
`match op_type` replay interpreters in corrupted-DB recovery
(`src-tauri/src/db/recovery.rs`), and the bulk lifecycle orchestration in `crud.rs`. There
was **no** test driving the recovery interpreters against the canonical kernel as a
differential — recovery was pinned only against hand-authored expectations, so its
agreement with the kernel (the exact property #2894 flags as "aligned only by comments")
was not CI-enforced.

## Fix (pure test code — zero production LOC)

New `src-tauri/src/db/recovery_kernel_parity_tests.rs` (654 lines), declared via a 3-line
`#[cfg(test)] #[path=...] mod` inside `recovery.rs` (child of the `recovery` module so it
reaches the private `recover_blocks_from_op_log` through `super::` with **no** visibility
widening).

1. **Structural parity (recovery interpreter vs kernel).** A `create_block` + `edit_block`
   + `move_block` corpus (the three non-divergent "Mirrors sql_only" arms) driven through
   `apply_op_tx` (kernel arm — reads blocks back out of the per-space engine to prove the
   ENGINE path ran, not the sql_only fallback, per the #891 lesson) vs
   `recover_blocks_from_op_log(conn, /*ms era*/ true)` into a constraint-free temp `blocks`
   table. Asserts restricted-shape equality `{id, block_type, content, parent_id}` over
   active rows (`position`/`page_id` excluded — recovery reconstructs them differently,
   #1252/#1245). Both arms replay a byte-identical cloned op-log so cohort timestamps align.

2. **Divergence pin (delete_block + restore_block).** delete child → delete parent →
   restore child. Pins the documented #2043 divergence: the kernel restores the tombstoned
   ancestor (#1884/#2017 via `project_restore_block_to_sql`) while recovery leaves it
   deleted (flat `(seed, deleted_at_ref)` cohort). An `assert_ne!` makes the divergence
   itself observable — a future author cannot silently "unify" the two.

3. Derived-state parity (properties/tags interpreter) deferred as fast-follow (needs an
   FK-correct blocks population under `foreign_keys=ON` + its own corruption-gate setup).

Converts "aligned only by comments" into a CI-enforced invariant for the agreeing arms
while pinning the intentional divergences as executable contracts. Prerequisite safety net
for the eventual (deferred, high-risk) extraction of recovery onto the shared projection.

## Verification

- `cargo nextest run -E 'test(recovery_kernel_parity)'` → 2 passed.
- `cargo clippy -p agaric --tests` → clean; `cargo fmt -p agaric --check` → clean.
- **Non-vacuity empirically re-verified (both arms) by an adversarial reviewer:** perturbing
  either arm's expected output reds the parity assert; forcing the divergence away in EITHER
  direction reds the pin. Kernel arm confirmed on the engine path (not the fallback). Zero
  production LOC confirmed via `git diff --stat`.
