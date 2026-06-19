# Session 1001 — /batch-issues loop: FE robustness hardening, batch 2 (2026-06-19)

## What happened

Second cohesive batch of the `/loop /batch-issues` run: five more frontend
robustness findings from the multi-agent deep review, each on a non-overlapping
file, built by parallel subagents and adversarially reviewed before ship. Pipelined
against batch 1 (PR #1785) which sat pending CI; prior PR #1783 was merged at the
batch boundary (closed #1638/#1746).

## Shipped

Single PR `fix/fe-robustness-deep-review-2`:

- **#1596** — `usePollingQuery.refetch` silently no-opped while the page was hidden;
  added an optional `{ force?: boolean }` to `load`/`refetch` that bypasses the
  `document.hidden` guard for explicit user-initiated refetches. Auto-polling paths
  wrapped in a no-arg `tick` so they never force (and to keep the typed-options
  `load` off the `EventListener` signature).
- **#1614** — graph-worker message-handler `catch` posted a structured error AND
  re-threw, fanning one failure into up to three signals via the global error
  listener; removed the re-throw so a handler failure produces exactly one
  structured `{type:'error'}` post, keeping the global listeners as the fallback for
  genuinely-uncaught errors.
- **#1615** — `QrScanner` used a hardcoded `id="qr-scanner-region"`, so two
  instances would collide on html5-qrcode's getElementById lookup; derive a stable
  per-instance id from `useId()` (colons stripped) used for both the JSX and the
  `Html5Qrcode` constructor.
- **#1610** — `HistoryPanel` restore depended on `BlockHistoryItem` not rendering a
  restore affordance for non-restorable ops (invariant owned by another component);
  extracted `getRestorableText`/`isRestorable` as the panel's single source of truth,
  used by both `restorableEntries` and the `handleRestore` guard, which now surfaces
  a toast instead of a silent no-op on a non-restorable entry.
- **#1593** — multi-select drag silently degraded to a single-block move when
  `moveBlocks` was unwired; now no-ops the drop with a `logger.warn` instead of
  relocating only the active block's subtree.

## Review pass

Five adversarial reviewers (one per item, none self-reviewing) re-read the code,
re-ran targeted suites, and ran `tsc`/`oxlint` on touched files. The #1593 reviewer
caught and fixed an `exactOptionalPropertyTypes` test error (`moveBlocks: undefined`)
the builder left; all other items were clean. Each reviewer hardened tests
(QrScanner two-instance distinctness, worker fallback-still-fires, HistoryPanel
panel-owned-guard via a stubbed child rendering restore on every row).

## Notes

- All five touch disjoint files — clean parallel build with no worktree needed,
  shipped as one cohesive PR. Full frontend suite green (581 files, 13503 passed).
- Backend item #1607 (MCP search filter-term byte-budget) was deliberately held for
  a later batch to keep this PR cohesively frontend.
