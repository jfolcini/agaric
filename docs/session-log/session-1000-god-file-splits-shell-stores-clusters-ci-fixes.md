# Session 1000 — #644 god-file splits, shell + stores clusters, and the rebase/CI fixes

## Shipped (PRs)

- **#870** `refactor(db)` — split `db.rs` (5749 LOC) → `db/{mod,pool,command_tx,recovery}.rs`
  and `op_log.rs` (2963 LOC) → `op_log/{mod,record,append,payload,bypass,query}.rs`.
  Behavior-preserving verbatim move; every external `crate::db::`/`crate::op_log::` path
  preserved via glob re-exports. Reviewer verified all 80 op_log fns + db hot-path fns
  byte-identical. Full suite 4453/0. `Refs #644` (partial — does not close).
- **#871** `refactor(materializer)` — split `handlers.rs` (4881 LOC) → `handlers/` (9 files)
  and `tests.rs` (7146 LOC) → `tests/` (17 domain files). The static-source guard
  `apply_tx_uses_begin_immediate_not_deferred` rescans a `handlers/*.rs` PROD_FILES
  allowlist (verified complete). Full suite 4453/0. `Refs #644` (partial).
- **#872** `fix(shell)` — five verified findings: STABLE_MESSAGES redaction drift (#700),
  `opener:allow-open-url` https scope (#701), notifier `recv_timeout` instead of a blocking
  `join()` that parked a tokio worker (#702), deletion of four never-set shutdown-flag
  newtypes (#703), log-dir-unwritable degrades to stderr instead of a pre-subscriber panic
  (#635). Reviewer-confirmed 4458/0. Closes #700 #701 #702 #703 #635.
- **#873** `fix(stores)` — splitBlock edit-failure abort + `retryOnPoolBusy` wiring (#730),
  undo `reanchorAfterRemoteOps` on remote sync (#731), per-block `enqueueMove` mover
  serialization + indent/dedent echo check (#774), prune deleted ids from `selectedBlockIds`
  on load (#798). Reviewer-confirmed 11731/0, tsc clean. Closes #730 #731 #774 #798.

`#644` left open with a re-scope comment: db/op_log = #870, materializer = #871; the
`loro/engine.rs` and `commands/pages.rs` slices are deferred pending maintainer input on
the module boundaries (their seams are less clean than db/op_log's).

## Friction → lessons captured

1. **Splitting a god-file breaks path-keyed prek guards.** A verbatim move still reds CI:
   the `check-dynamic-sql` baseline (per-file counts), the `check-raw-tx.py` allowlist
   globs, and the `doc-citations` hook all key off file path. Fix: re-anchor the baseline
   with `--update-baseline` (verify the diff is **count-preserving** — `36 db.rs → 3+33`,
   `22 handlers.rs → 18+1+3`, zero new sites), swap allowlist globs to the new dirs, repoint
   AGENTS.md + `docs/architecture/*` citations. The trap: both split branches forked from
   **before** the commit that added the dynamic-SQL hook, so their local pre-push didn't even
   contain the guard — it passed locally and only CI (which lints the merge with current
   `main`) caught it. **Rebase onto `origin/main` before trusting a green local pre-push.**

2. **Concurrent full-suite commits/pushes get OOM-killed.** Backgrounding three hook-heavy
   git ops (each spawns a full clippy/nextest build) spiked RAM; earlyoom killed them
   silently — each reported `exit 0` but nothing landed (HEAD unmoved, remote SHA
   unchanged). Serialize commit/push in the foreground and verify each landed with
   `git log -1` / `git ls-remote`.

3. **`cargo fmt` prek hook is `--check`, not auto-fix** — an unformatted long line a
   reviewer left aborted the commit; run `cargo fmt` in `<wt>/src-tauri`, re-stage, recommit.

4. **`gh pr edit --body` is broken by GitHub's Projects-classic deprecation** (GraphQL
   error on `projectCards`); use `gh api -X PATCH /repos/.../pulls/<n> -F body=@file` instead.

Skill (`.claude/skills/batch-issues/SKILL.md`) pitfalls updated with lessons 1–3.

## Note for maintainer

The "unable to select next GitHub token from pool" on the release badge is the Claude review
GitHub App exhausting its installation-token pool (overnight PR/review volume) — an external
rate-limit, not a repo/workflow change. The 0.5.0 Release workflow itself ran green.
