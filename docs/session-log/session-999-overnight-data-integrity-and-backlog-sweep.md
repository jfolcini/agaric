# Session 999 — 0.5.0 release + overnight data-integrity & backlog sweep

Long autonomous `/loop /batch-issues` run (2026-06-10 evening → 2026-06-11 ~06:00 CET).
Released 0.5.0, then drove the 214-issue backlog hard in parallel (5–6 agents at once,
builder + adversarial reviewer per item, worktree-isolated), pipelined against CI.

## Release

- **0.5.0** cut via `scripts/release.sh` (bump `6268efcc` + signed tag). First attempt
  failed in the local bundle build because `dev.db` lacked migration 89 (spaces registry,
  #804) — `sqlx migrate run`, re-run. Published with all platform assets.

## Backlog plan

214 open issues triaged into a 12-phase order (CI trust → sync/data integrity → recovery →
privacy → editor fidelity → frontend clusters → mobile → gcal → FTS → arch → tooling →
features). Living plan tracked in agent memory (`project_backlog_plan_2026-06.md`).

## Merged this session

- **Phase 0 — CI trust:** #820 (validate-all/dco/detect-changes gaps, rust-cache split,
  claude/codeql bounds), #821 (signing-secret scoping out of the JS build, Rust toolchain
  pin 1.95.0), #831 (prek hook hardening: append-only backstop, sanitize coverage, evasion
  fixes, pinned tauri CLI). #832 (skill: issue-closing hygiene).
- **Phase 1 — data integrity P0:** #835 (#792 Loro peer-id epoch across snapshot RESET +
  fork guard — was silent op drop / release-mode corruption), #839 (#618 era-aware recovery,
  INTEGER-ms deleted_at + gated space_id, migration 0090), #846 (#611 chunked binary sync
  wire — sync survived past the 10MB JSON frame cap), #847 (#622 name-keyed tag map, ends
  concurrent-AddTag resurrection — #709 Phase 0+1), #856 (#800 cert-less device-claim
  bypass), #857 (#793/#794/#617/#802 snapshot/cache RESET fixes).
- **Phase 2 — recovery/replay:** #852 (11 issues — cohort cascades, missing replay arms,
  gated derived replay, ApplyOp retry semantics, space_id parity, redo gate + migration 0090).
- **Phase 3 — privacy:** #842 (#609 bug-report redaction).
- **Phase 5 — frontend clusters:** #825 #827 #829 #830 #834 #836 #837 #841 #844 #848 #854
  (stores, journal/agenda, search/find, shell, hooks, design, heavy-features, editor/blocktree,
  mobile, shell-trio theme/deeplink/error-boundary, search-trio).
- **Phase 6 — mobile:** #844 (#760).
- **Phase 7 — gcal:** #849 (reliability: auto-refresh, capped Retry-After, error clearing,
  resilient callback, tolerant decode, true 10 QPS).

## Open at session end (CI-pending / held)

- **#860** MCP hardening batch (#633 #636 #693–#699).
- **#861** gcal remainder (#628–#632) — rebased onto #849 after a same-module merge made its
  base stale (see the worktree-base-stale lesson in agent memory).
- **#858** editor markdown round-trip fidelity (#710 #711 #725) — **HELD FOR MAINTAINER**:
  the new serializer escapes are forward-corrupting on not-yet-updated peers, which persist
  and sync the corruption back. No corruption-free status quo exists (old pipeline already
  mangled these chars), but a 0.5→0.6 rollout must update all devices or gate on a format
  version. jfolcini decides rollout sequencing before merge.

## Method notes

- Every batch: domain builder subagent → second adversarial reviewer (re-ran suites,
  revert-sims, source-verified vendored crates, hunted wire/old-client compat). Reviewers
  caught real defects the builders missed (PDF stretch regression, dco case regression,
  orphaned rust-cache key, breadcrumb ArrowLeft leak, the #631 timed-event decode wedge,
  #629/#631 prune/adoption safety, …).
- Out-of-scope findings filed as issues, never deferred in comments: #822 #823 #824 #826
  #828 #833 #838 #840 #843 #845 #850 #851 #853 #855 #859.
- Closed #40 (DMABUF fix shipped in 0.2.0) and #783 (fixed by #804); re-scoped #612/#681 to
  their deferred remainders.
