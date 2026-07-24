# Session 1222 — Mock purge parity completeness (#3091)

**Issue:** #3091 (follow-up from the #3079 review; part of the #3082 lineage)

## What

All four pre-existing mock↔backend purge gaps closed, each verified against the
backend source of truth (measure, don't imagine):

1. **Soft-delete guard** — mock `purge_block` now rejects live/missing blocks with
   byte-identical messages and error kinds to `purge_block_inner`
   (crud.rs:1521-1531), via the established #2463 rejection shape.
2. **Uniform satellite cleanup** — shared `purgeCohortAndSatellites` used by all
   three purge handlers: `blockTags`/`blockTagRefs` on BOTH FK sides (incl. the
   purged-block-used-as-tag sweep), attachments + `attachmentBytes` by row
   `block_id`. Bonus latent bug fixed: the old `attachments.delete(blockId)` was
   keyed by attachment_id — a silent no-op that never deleted anything. Review
   confirmed zero regression on the previously-cleaned tables.
3. **Depth cap** — mock BFS mirrors `cascade_depth_saturated` exactly (0-based,
   98 passes / 99 fails both sides, same message/kind).
4. **Reserved-value validation** — backend validates only (no normalization):
   case-sensitive todo_state membership + empty-value rejection mirrored across
   set_property/set_property_batch/create_blocks_batch. `priority` knowingly
   left permissive (user-configurable levels; documented honestly after review
   corrected the rationale — the backend does have a fixed def-absent fallback).

## Conformance

- New backend-authored fixture `purge_block_used_as_tag` (non-vacuous: the
  tag_id-side row exists pre-purge and `block_tags: []` fails without the fix);
  ratchet tuple `purge_block/used-as-tag-cleanup` activated.
- Snapshot NOT extended with `block_tag_refs` (no op populates it — always-[]
  key for zero coverage); `purge_live_block_errors` fixture skipped (the runner
  applies the guard-free op path; guards are command-path-only) — both skips
  verified in runner source and documented in the coverage allowlist.

## Verification

- vitest (mock suites + the out-of-glob tauri-mock.test.ts): 19 files / 491
  passed incl. new purge-parity.test.ts (11 durable re-queried-effect tests).
- Rust conformance without update-mode: passed. `tsc -b` 0; oxlint clean (2
  pre-existing complexity baselines untouched).
- Adversarial review: SHIP, zero code fixes; two LOW notes (priority-comment
  accuracy — fixed; batch date-format permissiveness — pre-existing, out of
  scope).
