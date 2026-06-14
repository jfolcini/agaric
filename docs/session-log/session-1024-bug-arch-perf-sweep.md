# Session 1024 — bug / arch / perf / mobile sweep + interactive steering (2026-06-14)

Continuation of the autonomous `/loop /batch-issues` pass, with live maintainer steering.
High parallelism (up to ~6 concurrent agents), ≤2 concurrent Rust compiles for earlyoom.

## Shipped (merged)

- **#691** — gcal push-lease renewal arm (extend-only `renew_lease`, never claims; reuses
  `claim_lease`'s query shapes, no `.sqlx` change).
- **#851** — recovery: per-device compaction floor (`MAX` over per-device `MIN(seq)`) + bounded
  persist-retry (1→4). Review caught & fixed a `cargo sqlx prepare` over-deletion of 253 `.sqlx`
  files (delta is additive: 1 new entry).
- **#742** — mobile: gate QuickCaptureRow on `isMobilePlatform()` (capability) not width; dedup
  `isMobilePlatform` into `lib/platform.ts`. + IPC error-path test.
- **#748** — sync: `visibilitychange` pause/resume (re-arm + `syncAll` on visible, `flushAllDrafts`
  on hidden; generation-guarded so a suspended in-flight sync's late timeout doesn't toast).
- **#727** — roving-editor lifecycle hardening (mount-abort mis-attribution, unguarded unmount
  dispatch, closeKey-stuck suggestion plugin). Editor e2e green.
- **#1089** — finish the IconButton migration (JournalControls incl. **calendar trigger**,
  PageHeader, HistoryView) + forward guard. The calendar trigger was fixed (not reverted) per
  maintainer steer — the Tooltip exposed a test-mock gap (`visualViewport` lacked
  `addEventListener`), not a prod bug; completed both mocks (#1201 follow-up after the base merged
  without it).
- **#976** — closed: the final 2 audit sub-items (`/duplicate` slash + `Ctrl+Shift+J`; Turn-Into
  `Ctrl+Shift+T`), both collision-free. The other 21 had shipped in #1046–#1049 — found by
  reading the issue's status comment.
- **#1075** — consolidate `pageBlockRegistry` onto ref-counted page-store slots. Careful retry of
  the reverted PR #1124 per maintainer root-cause guidance (preserve store identity + keep
  `useEffect` timing); the e2e #1124 broke (`undo-redo-blocks` "depth in place") is 6/6 green.
- **#859** — gcal: adopt an existing dedicated calendar before creating (crash-safe lookup via
  calendarList), mirroring the #631 events fix.

## Open at session end

- **#1206 (#638)** — sync: always-ACK skipped file offers so the sender doesn't stall 180s.
  Reviewed SHIP, pre-push green; validate CI was still running at stop time.

## Filed (out-of-scope findings)

- **#1188** — `check-dynamic-sql.py` misses turbofish call syntax (guard blind spot).
- **#1189 / #1190** — Playwright visual-regression baselines + Storybook evaluation (per the
  maintainer's "issues only" decision on visual testing).
- **#1204** — gcal steady-state cross-device event dedup (the list→insert race; #859 follow-up).

## Process lessons (now in memory)

- **Read issue comments, not just the body** — #976 was 21/23 already done per a maintainer
  status comment; the body alone would have re-done finished work. (`feedback_read_issue_comments`)
- **Fix, don't revert** — the #1089 calendar trigger; the failure was a test-mock gap.
- SSH push transport was flaky all session → used HTTPS via `gh auth git-credential`, verifying the
  remote SHA after each push. FE worktrees still need `src-tauri/.env`+`dev.db` seeding (the
  pre-push sqlx-prepare check runs regardless of diff). `npx oxfmt --write` with an empty arglist
  reformats the whole tree — always pass explicit files. New `scripts/*.mjs` need `chmod +x`.
- Adversarial review repeatedly earned its cost: caught the #851 `.sqlx` over-deletion, the #770
  cross-block content-corruption + the real 2-connection-pool race, the #667/#1071 missing #646
  markers, and the #1089 calendar test-mock root cause.

## Visual-testing question (maintainer)

Confirmed the repo has strong behavioral (69 e2e) + a11y (242 axe) coverage but zero
visual-regression / Storybook. Recommended staged adoption (Playwright `toHaveScreenshot` first,
Storybook scoped to leaf primitives) with strict flake mitigation; filed #1189/#1190 per the
"issues only, you prioritize" decision.
