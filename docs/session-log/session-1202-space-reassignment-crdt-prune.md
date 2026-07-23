# Session 1202 — Prune the old space's LoroDoc on genuine space reassignment

**Date:** 2026-07-23
**Branch:** `fix/space-reassignment-crdt-prune`
**Closes:** #2907

## Summary

Reassigning a page from space S1 to S2 (via `SetProperty(space)`) hydrated the subtree
into S2's per-space LoroDoc but **never pruned it from S1's** — so the page became a durable
member of BOTH per-space CRDTs. On sync, both docs carried the subtree, producing dual
membership and potential cross-space resurrection. This prunes the subtree from the OLD
space's LoroDoc on a genuine reassignment, before hydrating into the new space.

## The fix (`agaric-engine/src/apply/loro_apply.rs`, `SetProperty(space)` branch)

Order: capture `old_space = resolve_block_space(block)` **before** projection → run
`project_set_property_to_sql` (repoints `blocks.space_id` to the new, registered space) →
resolve `new_space` **after** → prune OLD doc → hydrate NEW doc.

The prune fires only when `old_space.filter(|old| *old != new_space)` is `Some` — i.e. the
target genuinely moved between two **different registered** spaces:

- **First assignment** (no-space window / #2326): pre-projection resolve is `None` → no prune.
- **Same-space no-op / unregistered target** (#708): `project_set_property_to_sql` leaves
  `blocks.space_id` untouched for an unregistered target, so `new == old` → no prune.
- **Genuine cross-space reassignment**: prune.

The prune calls the engine method **directly** — `guard.engine_mut().apply_purge_block(block_id)`
on the OLD space's recording guard — **not** `apply_purge_block_via_loro` (which also runs
the SQL purge cascade). `apply_purge_block` touches **only the LoroDoc** (collect subtree →
`tree.delete` → remove `block_properties`/`block_tags` map entries → `doc.commit()`), issues
zero SQL, and is idempotent. The SQL rows survive under the new space.

## Data-loss safety (the key invariant)

The prune is nested inside `if let Some(new_space) = …`, so a prune can only fire when
hydrate-new also runs. Combined with the `old != new && registered` gate, a subtree can
**never** be orphaned out of both docs — the worst possible failure direction of this fix is
"prune is a no-op" (bug persists), never data loss. Boot migration
(`migrate_personal_pages_to_work`) routes through the same path; `rehydrate_registry` loads
the OLD (Personal) doc before the migration runs, so the prune finds the subtree.

## Tests

- `reassignment_prunes_old_space_and_converges_only_in_new_2907` — reassign S1→S2, export
  **both** per-space snapshots, import each into a **fresh peer** engine, assert the subtree
  is only in S2 (content/parent verified) and absent from S1. Non-tautology confirmed: with
  the prune arm gated off the test fails (`must be PRUNED from the OLD space's engine`).
- `first_assignment_and_same_space_set_do_not_prune_2907` — first assignment and a same-space
  re-set leave the subtree intact in S1. **Strengthened during review**: because hydrate is
  idempotent, a bare presence assertion could not detect a spurious prune+re-hydrate (delete
  then recreate). The same-space branch now pins S1's op-log frontier
  (`checkpoint_frontiers()`) across the set — a true no-op leaves it unchanged; a spurious
  prune+re-hydrate advances it. Verified to fail under `old_space.is_some()`-alone gating
  (`Frontiers` mismatch), making the `old != new` refinement genuinely regression-protected.

## Verification

`cargo clippy --lib` clean; `cargo nextest` over the space/loro/apply/projection/convergence/
reassign/migrate/hydrate/purge slice = **476 passed, 0 failed**. `.sqlx` unchanged (no new
compile-checked `query!` macros). Adversarial review confirmed data-loss safety, ordering,
convergence/determinism/idempotency, boot-migration ordering, and independently reproduced
both non-tautologies.
