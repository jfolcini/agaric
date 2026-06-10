# Session 998 — Release 0.5.0 + backlog plan + CI-integrity batch

## Shipped

- **Release 0.5.0** cut via `scripts/release.sh 0.5.0` — bump commit `6268efcc` + signed tag
  `0.5.0` pushed to origin; Release workflow drafts the GitHub Release for manual publish.
  First attempt aborted in `verify-release-build.sh`: local `dev.db` was missing migration
  89 (spaces registry, #804), so the sqlx macros failed with `no such table: spaces` while
  building the `agaric-mcp` sidecar. Fix: `sqlx migrate run` in `src-tauri/`, re-run.
  Lesson re-learned: piping `release.sh` through `tail` masks its exit code; run it bare.

- **Phase 0 Batch A — CI integrity cluster** (#805 #809 #810 #811 #812 #813 #814), one PR:
  - `validate-all` now `if: always()` + explicit `needs.*.result` assertion (no more
    skip-through green when a sibling fails or is skipped). (#805)
  - `dco` fails on `gh api` error or zero commits scanned; sign-off email matched as a
    fixed string instead of an interpolated ERE. (#809)
  - `detect-changes` propagates `git diff` failures instead of skipping both builds. (#810)
  - Android path filter covers `Cargo.{toml,lock}` and the remaining cfg(android)-gated
    Rust files. (#811)
  - Production `npm run build` (tsc -b && vite build) now runs on PRs in the vitest job. (#812)
  - Swatinem rust-cache `shared-key` split per job class: `rust-lint` / `rust-cov` /
    `rust-mcp` / `rust-release`. (#813)
  - `concurrency` + `cancel-in-progress` + `timeout-minutes` for claude, claude-code-review,
    codeql workflows (PR-scoped groups; main pushes never cancelled). (#814)
  - Built by one subagent, adversarially reviewed by a second (re-ran zizmor, YAML parse,
    regex/needs-context checks).

## Backlog plan

214 open issues triaged into a 12-phase execution order (CI trust → sync/data integrity →
recovery/replay → privacy leaks → editor fidelity → frontend clusters → mobile → gcal →
FTS/cache → arch refactors → tooling → feature plans; parked/ideas stay parked). The living
plan with per-phase issue lists is tracked in agent memory
(`project_backlog_plan_2026-06.md`) and updated as batches ship.

Rust-deps policy agreed with maintainer: security/patch Dependabot bumps merge immediately;
major/minor upgrades of core crates (tauri/wry, loro, sqlx) wait until Phases 1–2 land, then
go as one dedicated soak batch.
