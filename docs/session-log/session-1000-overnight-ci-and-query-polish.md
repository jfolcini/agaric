# Session 1000 — overnight CI flake fix + advanced-query polish

Autonomous `/loop /batch-issues` run (2026-06-17 evening → overnight CET). Maintainer
steer for the night: big refactors first, auto-merge own greens, ask questions upfront.

## PR-review reconciliation

- **PR #1459** (nested AND/OR/NOT filter groups, #1280): fixed the bot's
  CHANGES_REQUESTED — the empty-group placeholder hard-coded "matches everything"
  regardless of combinator, but the engine treats empty `And` as TRUE and empty `Or`
  as FALSE. Split into `emptyGroupAnd`/`emptyGroupOr` i18n keys, branch on `node.op`.
- **PR #1461** (Playwright CI flake, #1458): the prior retry was self-defeating —
  `timeout 360 npx playwright install-deps` only SIGTERMs npx, orphaning its child
  `apt-get`, which keeps holding `/var/lib/dpkg/lock-frontend`, so retries 2–3 die
  instantly on the lock. True root cause: the runner's `unattended-upgrades`/`apt-daily`
  grab the dpkg lock at boot, so any apt step landing in that window queues behind a
  ~6-min job and runs out the 20-min budget during SETUP (this also cancelled the
  `lint`/`cargo-tests`/`mcp-tests` apt steps — lint burned 20m16s). Added a reusable
  `.github/actions/prepare-apt` composite (stop background apt jobs, wait ≤180s for the
  dpkg lock, repair half-finished dpkg state, bound mirror stalls) wired before every
  apt step, and a lock-aware retry on the Playwright deps step.

## Refactor scoping

- **#645** (Tauri-free `agaric-core` crate): audited coupling before attempting. The
  diagnostics-bin extraction is already done (`members = [".", "diagnostics"]`). The
  remaining `agaric-core` carve-out is **not** a clean leaf move — the target cluster
  (`op`/`op_log`/`hash`/`ulid`/`loro`) is mutually coupled (`hash::verify_op_record`
  takes `op_log::OpRecord`) and reaches outward into `error`/`db`/`space`/`mcp`/
  `sync_protocol`/`materializer`/… , and `ulid`/`op_log` carry sqlx (needs a 2nd offline
  cache). Documented a phased plan on the issue, re-labelled `plan`. Not started
  unattended (needs a boundary-design decision).

## Shipped this session

- **#1447** advanced-query grouped headers: resolve Tag/Page group keys (raw ULIDs) to
  titles via the existing single `batchResolve`, map BlockType/Priority codes to display
  labels (reviewer caught these were emitted raw by `group_key_expr`), `"none"` → "(none)".
  Display-only; full FE suite green.
