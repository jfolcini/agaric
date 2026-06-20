# Session 1098 — /batch-issues loop: 4 correctness fixes, batch 42 (2026-06-20)

## What happened

Four correctness findings from the deep review (mixed Rust + FE, disjoint files), built
by parallel subagents in `wt-batch42` and reviewed together. Part of the maintainer-
requested sweep of all open `correctness`-labelled issues. Two of the four turned out to
need a re-scope after investigation (documented below) — handled correctly.

## Shipped

PR `fix/deep-review-correctness-5`:

- **#1527** (MEDIUM, `loro/engine/apply.rs`) — `create_block_impl`'s re-apply branch
  resolved an ABSENT requested parent to `Root` and moved an already-correctly-parented
  node to root. Switched it to `resolve_move_target` semantics: an absent parent now keeps
  the node's CURRENT tree parent and records pending intent (`attach_pending_children`
  re-attaches when the parent arrives), matching the move path. Explicit `None` still →
  Root; a present parent still reparents. Create idempotency preserved.
- **#1541** (LOW, `loro/engine/`) — cycle-forming reparents from remote ops were skipped
  with only a noise-level warn. Added a `cycle_rejected_metrics` module (process-global
  `AtomicU64` count + last block_id, mirroring `snapshot_fallback_metrics`); the skip site
  records it alongside the warn. Skip behaviour unchanged — observability only.
- **#1530** (MEDIUM, FE) — the graph cache went stale on page/`[[link]]` mutations. A
  prior partial fix had wired only `block:properties-changed`, which never fires for
  topology mutations (the wrong axis). Added a dedicated `graph-structure-events` signal
  (module-level counter, mirroring `block-property-events`) bumped at the local-CRUD funnel
  (`page-blocks.ts::notifyUndoNewAction` + `appendBlock`) and on `sync:complete`; GraphView
  folds `propertyKey + structureKey` into its invalidation key (property signal + TTL kept
  as backstops). The test now fires a REAL structure mutation, not the invalid
  property-event proxy.
- **#1538** (LOW, `recovery/replay.rs`) — the H-4 cursor sanity uses global
  `MAX(op_log.seq)`. Investigation showed this is CORRECT, not a bug: the apply cursor
  (`materializer_apply_cursor`) is a single global scalar with no `device_id`, and
  `advance_apply_cursor` takes the max across all devices — so global MAX is its legitimate
  ceiling and per-device scoping would REGRESS (false-flag valid cursors). Landed the
  issue's own recommended interim documenting comment; the substantive per-device-cursor
  work is tracked by #412.

## Review pass

Reviewer (APPROVE, all four correct): mutation-checked #1527 (keep-parent; `resolve_parent`
vs `resolve_move_target` differ only in the absent-parent case) + idempotency
(`create_is_idempotent_under_replay` passes); #1541 (tree unchanged + counter bump,
`cyclic_move_lands_position_not_reparent` passes); #1530 (audited all 18 `notifyUndoNewAction`
sites + `appendBlock` + `sync:complete`, real-mutation test incl. across-unmount); #1538
(verified the schema/advance-cursor analysis — per-device would regress). clippy
`--all-targets` clean; 395 Rust + 2883 FE tests; tsc + oxlint clean; `.sqlx`/baseline
unchanged.

## Notes

- Files disjoint across the 3 builders (loro/engine ; src/ graph FE ; recovery/replay.rs)
  — no shared-worktree clobber. Not MCP-touching (no Phase F binary needed).
- #1538 closed-as-documented with #412 carrying the substantive fix.
- Branch base is current `origin/main`.
