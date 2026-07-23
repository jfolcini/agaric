# Session 1210 — Scope tag-inheritance rebuild to restore-only for lifecycle ops (#2934)

## Issue
#2934 — `perf(backend): Full-vault RebuildTagInheritanceCache still fires on every
local delete/restore` — the #2669 scoped-recompute class was never extended to
content lifecycle ops, so every local delete/restore/purge triggered a full-vault
tag-inheritance cache rebuild.

## What shipped
`RebuildTagInheritanceCache` is now dropped for content **delete** and **purge**
(where a scoped `recompute_subtree_inheritance` is provably equivalent to a full
rebuild) and **retained** for content **restore** (where it is not).

### Why restore diverges (the load-bearing subtlety)
On fixture `S1(page) → AA[#T1] → BB → CC[#T1]`, deleting `BB` then restoring it:
- `rebuild_all` yields `{(BB,T1,AA), (CC,T1,AA)}`.
- The scoped `recompute_subtree_inheritance` drops `(CC,T1,AA)` — its step-3
  self-tag exclusion (`WHERE st.id NOT IN (SELECT block_id FROM block_tags
  WHERE tag_id = …)`, `agaric-store/src/tag_inheritance/incremental.rs`) excludes a
  block that is itself a direct tagger from receiving the re-added inherited row.
  `rebuild_all` lacks that exclusion.

Delete and purge are monotone removals: a survivor can never inherit from within a
deleted/purged subtree, so the self-tag exclusion never fires on removal and the
scoped recompute is byte-equivalent to a full rebuild.

## Implementation
- `materializer/dispatch.rs`:
  - `CONTENT_LIFECYCLE_REBUILD_TASKS` (7) — content delete/purge; drops
    `RebuildPagesCache` + `RebuildTagInheritanceCache`.
  - New `CONTENT_RESTORE_REBUILD_TASKS` (8) — content restore; drops
    `RebuildPagesCache` only, **retains** `RebuildTagInheritanceCache`.
  - `lifecycle_rebuild_tasks(&OpType, block_type_hint)` keys on op-kind:
    content+restore → restore set, content+delete/purge → lifecycle set, else FULL.
    Non-content hints (page/tag/unknown) fall through to FULL — no accidental
    narrowing.
- `materializer/{dispatch,coordinator}.rs`: the #2935 debounce path is now
  op-aware. `DebounceState` gained `needs_inheritance` (OR-accumulated via `|=`,
  reset only at the two disarm/fire points). A content restore coalesced with
  content deletes in one debounce window still fires the inheritance rebuild —
  under-firing is structurally prevented; over-firing is correctness-safe
  (rebuild is idempotent).
- `command_integration_tests/conformance.rs`: delete + purge assert `scoped ==
  rebuilt` (equivalence, rebuild dropped); restore rewritten on the divergent
  fixture — asserts pre-`settle` `scoped` drops `(CC,T1,AA)`, `scoped != rebuilt`,
  and `settled == rebuilt` (the retained rebuild heals). Pinning tests assert
  restore RETAINS / delete+purge DROP the task.

## Verification
Adversarial re-review (independent) confirmed the debounce OR-accumulation cannot
under-fire, the op-kind plumbing has no accidental narrowing, and the restore test
drives the real settle pipeline (not a transient provisional position). Full suite
`3321 passed, 6 skipped`; clippy `--all-targets` 0 warnings; `fmt --check` clean.

## Notes
Adversarial review earned its cost again: the first builder pass dropped the
rebuild for restore too; review empirically proved the `(CC,T1,AA)` divergence,
sending it back to the correct restore-retention design.
