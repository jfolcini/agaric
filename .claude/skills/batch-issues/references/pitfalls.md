# Batch-issues — pitfalls

Each entry is a failure that happened, with the recovery. Read the one you are about to risk.

## Git state and PR topology

### A scrambled shared tree

After a parallel `git stash` / `reset` / `checkout` sweeps up another agent's edits, do not trust stash provenance; reconstruct and let the full gate decide.

### Stacked PRs merge bottom-up and get no CI

A PR opened against another PR's branch merges into that branch, not `main`; if the base PR already merged, the child's content never reaches `main`. Merge oldest first and check each landed (`git log origin/main -- <path>`). `ci.yml` runs only on PRs based on `main`, so a stacked PR's green rollup is the review bot alone. Recovery: rebase the open branch onto `origin/main`, force-push, and repoint with `gh api /repos/<owner>/<repo>/pulls/<N> -X PATCH -f base=main` (`gh pr edit` no-ops here or fails on a Projects (classic) GraphQL error; change the body with the same PATCH, `-f body=…` or `--input` a JSON file).

### Scratch files read back after a long wait

Bracket the wait with `scripts/scratch-file.sh fingerprint` / `verify` so another agent's overwrite is caught.

### `git reset --soft <moving ref>` in a worktree writes a revert

Worktrees share one `.git`, so `origin/main` can advance under you. Resetting onto it commits the old tree against the newer base: a silent revert of everything that landed in between. Pin the SHA (`base=$(git rev-parse HEAD)`), and after any reset-and-recommit read `git diff --stat origin/main...HEAD`: deletions you cannot explain are a revert.

### A commit on a Dependabot branch survives only if you make it survive

Dependabot force-pushes its branch on rebase or supersession, sometimes under a new PR number, and a human commit on it vanishes. A fix that stands alone (a test assertion, an `overrides` entry) goes in its own PR off `main`. One that cannot (a relock without the bump is meaningless) goes on the Dependabot branch: comment on the PR with what broke and what you did, verify the push by SHA, and merge with `gh pr merge <n> --squash --subject "<human commit subject>"` so the diagnosis is the headline.

Never take a Dependabot `Cargo.lock` verbatim: it is a snapshot of an older `main` and reverts any bump landed since (an advisory fix). Apply its lock hunks three-way onto `main`; a local `cargo update -p X --precise V` can re-point unrelated edges, so read the lock diff either way.

### A staged change carried across branches

After a failed commit, never `git switch` with changes still staged: they ride into the other branch. Finish or unstage first.

### Two green PRs that break main together

Each PR's CI tests it against the `main` it was cut from, so two approved PRs that touch the same component can each be green and still fail once both are in (a renamed label and a new test that looks it up by the old name). Before merging the second of two PRs that share files or a component, rebase it on the first and wait for its CI.

## Branches and `gh` in a cloud session

A cloud session is handed one designated branch. It carries at most one PR; every other item gets its own `claude/<issue>-<slug>` branch off `origin/main`, pushed and opened the same way. The repo deletes a branch when its PR merges, so a designated branch whose PR merged is restarted from `origin/main` before it carries new work.

GitHub GraphQL returns 403 from a Claude Code cloud session, so every `gh pr` and `gh issue` subcommand fails there; `gh api` REST works. With `R=repos/jfolcini/agaric`:

- PR board: `gh api "$R/pulls?state=open&per_page=100" --jq '.[] | [.number, .user.login, .title] | @tsv'`
- Checks: `gh api "$R/commits/<head sha>/check-runs?per_page=100" --jq '.check_runs[] | [.name, .status, .conclusion, .id] | @tsv'`, with the sha from `gh api $R/pulls/<n> --jq .head.sha`. `dco` and `validate-all` are both check runs.
- Failed log: `gh api $R/actions/jobs/<id>/logs`, with the failed row's `id` from the checks query.
- Issue with comments: `gh api $R/issues/<n> --jq .body`, then `gh api "$R/issues/<n>/comments?per_page=100" --jq '.[].body'`.
- Review bodies: `gh api "$R/pulls/<n>/reviews?per_page=100" --jq '.[].body'`.
- Open a PR: `gh api $R/pulls -f base=main -f head=<branch> -f title='<title>' -F body=@"$file"`.
- Merge: a draft first goes ready with `gh api -X POST $R/pulls/<n>/ccr/ready_for_review`, then `gh api -X PUT $R/pulls/<n>/merge -f merge_method=squash -f sha=<head you checked>`, so a push that lands after your check is refused instead of merged unseen. Leave the head branch: the repo deletes it on merge, and the proxy refuses a ref delete with 403.

## Lint and format

- `oxfmt --write` reflows JSX and detaches an `oxlint-disable-next-line` from the line it covered. Use a `/* oxlint-disable rule -- reason */ … /* oxlint-enable rule */` pair, and re-run `npx oxlint` after formatting.
- Never `oxfmt --write .` or `npm run format`: it reformats all TOML in a style taplo rejects. Format only your files.
- A rules-config change and its linter version bump land in one commit; oxlint rejects a config naming rules it does not know.
- Swapping `<div role="status">` for `<output>` removes the literal attribute a test may query. Grep the tests for `[role=` / `toHaveAttribute('role'` first, and run the full suite for a11y sweeps.
- The gitleaks hook flags a random-looking fixture secret (a token like `agt_0123…cdef`) as a leaked key. Build fixtures from a repeated character (`` `agt_${'a'.repeat(32)}` ``), never an allowlist entry.

## Rust and sqlx

- The pre-push clippy runs sqlx online against `dev.db`, so the DB must match the branch's migrations. When switching between migration-divergent branches: `cd src-tauri && set -a && . ./.env && set +a && sqlx database drop -y && sqlx database create && sqlx migrate run --source migrations`.
- Before migrating a timestamp or enum column, grep the column name for cross-table `> ?` / `< ?` predicates and for values copied between columns; migrate a coupled cluster in one PR. Backfill with `CAST(ROUND((julianday(col) - 2440587.5) * 86400000.0) AS INTEGER)`, NULL-guarded.
- Bumping a ratchet baseline (`dynamic-sql-baseline.txt`, `table-ownership-baseline.txt`) is a last resort. "The safe construct can't express this" is usually an arity problem: N fixed-arity `query_scalar!` call sites beat one dynamic call. If you do bump, say what you tried.
- Broken rustdoc intra-doc links red the push (`cargo-doc-links` hook). Links in a `mod x;` declaration resolve in the parent's scope.
- `internal compiler error: encountered incremental compilation error` is the toolchain, not the code: delete that crate's `src-tauri/target/debug/incremental/<crate>-*` directory and rebuild.

## Baseline reds in a worktree

A worktree's `node_modules` is a symlink to the main checkout's (`scripts/seed-worktree.sh`), which lags after a lockfile change: run `npm ci` in the main checkout. Before chasing a typecheck or Playwright red outside your diff, reproduce it on a clean `origin/main` worktree.

## Guards keyed on paths

Removing the last file of a kind (the last `.py`) trips a fail-closed "found zero" wiring check and leaves dead extension lists: grep `scripts/` and `prek.toml` for the extension first.

Splitting a file breaks path-keyed guards even for a verbatim move. Rebase onto `origin/main` first so the guards run locally, then:

- Re-anchor only the moved files: `node scripts/check-dynamic-sql.mjs --update-baseline <path>...`. Never `--all`, and never hand-edit the baseline: both launder unrelated drift into your diff.
- Swap `check-raw-tx.mjs` allowlist globs.
- Repoint `AGENTS.md` and `docs/architecture/*` citations, and the path strings in `vi.mock` / `vi.doMock` / `importActual`, which tsc does not check and which silently stop intercepting.

## Shell

- Never pipe a build, test run, or push through `tail` or `head`, and never read a piped exit code: `$?` is the last stage's, and a truncated log hides the failure. Redirect to a file and read the summary line.
- `pgrep -f` / `pkill -f` match their own shell's command line. Find a process by port or PID.
- Run a changed `.mjs` guard and its self-test on Node 22 as well as 24: 22 is the `engines` floor, and `node:sqlite` warns there only.
