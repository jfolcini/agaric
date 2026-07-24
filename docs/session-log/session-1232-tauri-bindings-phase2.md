# Session 1232 — tauri.ts→bindings.ts migration phase 2 (#2927)

**Issue:** #2927 (phase 2 of the 6-phase plan)

## What

First runtime-consumer batch migrated from `@/lib/tauri` wrappers to
`commands.*` from `@/lib/bindings`: **14 production files** fully dropped their
`@/lib/tauri` import. Baseline **155 → 141**.

- tasks (2): use-block-flush, use-block-tree-event-listeners
- drafts (5): useDraftAutosave, BlockTree, useUpdateCheck, useRecoveryStatus,
  useMdnsStatus
- history (5): ActivityFeed, HistoryRevertDialog, HistoryRestoreDialog,
  BlockHistoryItem, useHistoryDiffToggle
- links (1): external-link; import (1): BibliographySection

Unwrap pattern follows the #3010 precedent (CompactionCard/BugReportDialog):
`unwrap(await commands.X(...))` with `unwrap` from `@/lib/app-error`;
named-param wrappers inlined to positional args faithfully.

Deliberate deferrals: search wrappers (value-add: scope + AbortSignal +
date-filter marshalling — issue says keep), importMarkdown (Channel),
backlinks/history list wrappers (SpaceScope + pagination), NotificationsTab
(imports a never-touch plugin shim), and mixed-domain single-call files (a
listed-domain-only edit wouldn't drop the import). The 8 now-production-unused
pass-through wrappers were kept — `tauri.test.ts` still exercises them; deleting
them is a dedicated wrapper-retirement slice.

Tests: wrapper-mocked tests rewritten to mock `commands.*` with the
`{status:'ok',data}` envelope; 3 fallout tests fixed with a spread-actual
parallel bindings mock; invoke-transparent tests unchanged.

## Review

Mechanical consumer migration on the phase-0-hardened guards:
orchestrator-verified (tsc, all four guards re-run green); agaric-reviewer
covers the PR.

## Verification

`npx tsc -b` 0 errors; import-baseline 141 (no new/stale); bindings-parity
121/141 + 20 allowlisted (zero churn); ipc-error-path 59 components;
tauri-mock-parity green; oxlint clean on 28 changed files; vitest sweep 326
files / 7844 tests pass; 29 intended files changed.
