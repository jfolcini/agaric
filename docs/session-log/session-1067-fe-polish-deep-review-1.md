# Session 1067 — /batch-issues loop: frontend e2e polish, batch 17 (2026-06-19)

## What happened

Seventeenth batch of the `/loop /batch-issues` run, frontend lane. Built in worktree
`wt-fe17` on `fix/fe-polish-deep-review-1`, overlapped with backend batch 18
(`fix/be-robustness-deep-review-6`). Scoped to a single deep-review finding after a
second candidate (#1654) was dropped mid-batch as a duplicate (see below).

## Shipped

Single PR `fix/fe-polish-deep-review-1`:

- **#1616** (LOW, test reliability) — four Playwright e2e specs used bare
  `page.waitForTimeout(...)` fixed sleeps as synchronization points, which are flaky
  under load (the assertion races the sleep) and slow (always pay the full delay).
  Replaced five such sleeps with auto-retrying, condition-based waits
  (`expect.poll`, `toBeVisible`, `toContainText`) across
  `e2e/block-paste-outline.spec.ts`, `e2e/callout-roundtrip.spec.ts`,
  `e2e/table-view-render.spec.ts`, and `e2e/long-url-no-loop.spec.ts`. Deliberately
  left the one legitimate timing wait at `e2e/undo-redo-blocks.spec.ts:230` (a real
  undo-coalescing window, not a sync point) and `playwright.config.ts` untouched.

## Review pass

One adversarial reviewer verified each replaced sleep maps to the actual condition the
old timeout was masking (no assertion weakened or dropped), confirmed the
undo-coalescing wait was correctly left in place, and ran the affected specs twice
(after killing any stale Vite dev server on :5173 so Playwright tests this worktree's
code, not a stale one) to confirm they pass deterministically.

## Dropped mid-batch — #1654 (the "check the issues" catch)

The batch originally paired #1616 with **#1654** (elevation-tier design-token
adoption). Per a standing "check the issues in GitHub, just in case" instruction, a
pre-ship issue-state check revealed #1654 had **already been fixed and merged** by the
concurrent loop agent's PR #1809 (`fix/elevation-tokens`, with follow-up #1810). The
#1654 builder had produced a full duplicate. Recovered with
`git checkout -- <6 components + 6 tests>` in wt-fe17, leaving only the #1616 e2e
changes; no duplicate shipped. Validates verifying issue state before shipping when a
concurrent agent shares the repo.

## Notes

- Files: the 4 e2e specs only (test-only change; no app code, no codegen).
- Branch base (`7a804e94`) was stale vs current `origin/main` (`58dff693`); a diff
  confirmed origin changed none of the 4 specs, so the rebase onto origin/main was
  conflict-free.
- Pushed serially with backend batch 18 to avoid concurrent heavy pre-push (OOM); the
  FE pre-push compiles the full Rust suite in the worktree target dir.
