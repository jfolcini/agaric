# Batch-issues — pitfalls

Each entry is a failure that happened, with the recovery. Read the one you are about to risk.

## Git state and PR topology

### `git stash` / `reset` / `checkout` from a parallel subagent scrambles the shared tree

`git stash` is global: one subagent stashing sweeps up every other subagent's edits. Rules: parallel builders either work in separate worktrees or run sequentially, and every builder prompt says "do NOT run any git command; only edit files". After a scramble, do not trust stash provenance; reconstruct and let the full gate decide.

### Chained PRs merge bottom-up

A PR opened against another PR's branch merges into that branch, not `main`. If the base PR already merged, the child's content never reaches `main`. Merge oldest first. Recovery: rebase the still-open branch onto `origin/main`, force-push, and repoint the base with `gh api /repos/<owner>/<repo>/pulls/<N> -X PATCH -f base=main` (`gh pr edit --base` silently no-ops here; so does `gh pr edit --body`, use the same PATCH with `-f body=…`).

### A shared scratchpad lets one agent's PR body ship as another's

The scratchpad is per session, not per agent. Two PRs shipped a third PR's body (with its `Closes` lines) because both wrote `msg.txt`. Use `file=$(scripts/scratch-file.sh new pr-body)` for anything read back later, and `scripts/scratch-file.sh fingerprint` / `verify` around a long wait. Stage by path (`git add -A -- <paths>`) so a scratch file is never swept into a commit.

### Verify HEAD advanced after a commit

A pre-commit hook can abort the commit while the wrapper prints success. Check `git log --oneline -1` before pushing.

### `git reset --soft <moving ref>` in a worktree writes a revert

Worktrees share one `.git`; `origin/main` can advance under you. Resetting onto it keeps the old tree and commits it as a change against the newer base, i.e. a revert of everything that landed in between, with no error. Pin the SHA (`base=$(git rev-parse HEAD)`), and after any reset-and-recommit read `git diff --stat origin/main...HEAD`: deletions you cannot explain are a revert.

### A commit on a Dependabot branch survives only if you make it survive

Dependabot force-pushes its branch on rebase or when a newer release supersedes the group, and sometimes closes the PR and opens a new number; a human commit on that branch vanishes either way. If the fix stands alone (a test assertion, an `overrides` entry), put it in its own PR off `main`. If it cannot (a relock is meaningless without the bump), push it onto the Dependabot branch, comment on the PR saying what broke and what you did, verify the push landed by SHA (`git ls-remote origin <branch>`), and merge with `gh pr merge <n> --squash --subject "<human commit subject>"` so the diagnosis is the headline (the default body still concatenates both messages).

## Lint and format

- `oxfmt --write` reflows JSX and detaches an `oxlint-disable-next-line` from the line it covered. Use a `/* oxlint-disable rule -- reason */ … /* oxlint-enable rule */` block pair, and re-run `npx oxlint` after formatting.
- Never `oxfmt --write .` or `npm run format`: it reformats all TOML in a style taplo rejects. Format only your files.
- A rules-config change and its linter version bump land in one commit; oxlint rejects a config naming rules it does not know.

## Tests vs semantic changes

Swapping `<div role="status">` for `<output>` removes the literal attribute a test may query. Grep the tests for `[role=` / `toHaveAttribute('role'` before the swap, and run the full suite for a11y sweeps.

## Rust and sqlx

- Verify Rust batches with `cargo check --all-targets`; `--tests` and nextest skip benches, so a signature change leaves bench call sites broken until CI.
- A fresh worktree lacks `node_modules`, `src-tauri/.env`, and `src-tauri/dev.db`, all of which the pre-push hook needs. Run `bash scripts/seed-worktree.sh` from inside it (or push from the main checkout).
- The pre-commit clippy runs sqlx online against `dev.db`, so the DB must match the branch's migrations. When switching between migration-divergent branches: `cd src-tauri && set -a && . ./.env && set +a && sqlx database drop -y && sqlx database create && sqlx migrate run --source migrations`.
- Before migrating a timestamp or enum column, grep the column name for cross-table `> ?` / `< ?` predicates and for values copied from one column into another; migrate a coupled cluster in one PR. Backfill with `CAST(ROUND((julianday(col) - 2440587.5) * 86400000.0) AS INTEGER)`, NULL-guarded.
- Bumping a ratchet baseline (`dynamic-sql-baseline.txt`, `table-ownership-baseline.txt`, `tauri-import-baseline.json`) is a last resort. "The safe construct can't express this" is usually an arity problem: N fixed-arity `query_scalar!` call sites beat one dynamic call. If you do bump, say what you tried.
- Broken rustdoc intra-doc links red the push (`cargo-doc-links` hook). Fix the link; links in a `mod x;` declaration resolve in the parent's scope.

## Delegation

Do not hand "refactor X across the codebase" to one subagent. Split by file boundary into 3-6 subagents owning at most 6 files each, or do it orchestrator-direct.

## Guards keyed on paths

Splitting a file breaks path-keyed guards even for a verbatim move: re-anchor `dynamic-sql-baseline.txt` (`--update-baseline`), swap `check-raw-tx.py` allowlist globs, repoint `AGENTS.md` and `docs/architecture/*` citations, and rebase onto `origin/main` first so the guard runs locally.
