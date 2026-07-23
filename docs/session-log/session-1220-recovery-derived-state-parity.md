# Session 1220 — Recovery derived-state parity + widened corpus (#2894)

**Issue:** #2894 (fast-follow promised in PR #3087)

## What

Extends `src-tauri/src/db/recovery_kernel_parity_tests.rs` (pure-additive, one file,
2 → 8 tests) from structural parity to an honest derived-state contract:

- **page_id** — recovery's genuine computation (NULL on create, then self-reference +
  fixed-point parent-walk at recovery.rs:1174-1197) pinned against the CONVERGED
  ownership a settled materializer produces. Review corrected the framing: apply_op_tx
  stamps page_id only for pages (content blocks are NULL in-tx; the fan-out is the
  `SetBlockPageId` materializer task, unreachable in this in-tx harness), so the
  kernel-arm value is fixture-declared — the pin is recovery-vs-converged-ownership,
  not recovery-vs-kernel-projection, and the docstring now says exactly that.
- **position** — DIVERGENCE pinned (assert_ne!): kernel projects the engine's dense
  1-based child rank; recovery replays raw payload position (0 on create; move maps
  new_index through index_to_provisional_position). Non-vacuous over a byte-identical
  op_log; documents the #1245/#1257/#1252 reproject gap.
- **Widened corpus** — delete→restore→edit→move convergence; purge-mid-lineage
  physically absent from BOTH arms (recovery's real cascade purge arm at
  recovery.rs:1127 — a #615-class descendant leak would fail via the post-loop orphan
  promotion); reparent-under-restored-ancestor convergence; satellite ops pinned INERT
  to block parity (recovery's catch-all skip arm; satellites belong to
  recover_derived_state_from_op_log, out of scope).

All ops drive the real `append_local_op` + `apply_op_tx` pipeline; the engine arm reads
back from the per-space engine (the #891 fallback-proof).

## Verification

- `cargo nextest -E 'test(recovery_kernel_parity)'` → 8 passed; `-E 'test(recovery)'`
  → 124 passed, no regression; `cargo clippy --tests -p agaric` clean; fmt applied.
- Adversarial review: SHIP. The tautology attack on the page_id equality concluded
  "non-vacuous for recovery, but overclaiming the kernel side" — fixed in place
  (docstring/assert-message only, no logic change); all other claims verified against
  source (projection.rs:79, pagination/mod.rs:174, recovery.rs:894/1127/1155).
