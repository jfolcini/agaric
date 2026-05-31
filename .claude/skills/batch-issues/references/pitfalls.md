# Batch-issues — detailed pitfalls

Hard-won failure modes from real sessions. The core `SKILL.md` carries one-line
triggers; read the matching entry here when you hit (or are about to risk) one.

## Git state & PR topology

### Parallel subagents + `git stash`/`reset`/`checkout` in a SHARED tree = catastrophe

`git stash` is a GLOBAL op: one subagent stashing sweeps up *every other concurrent
subagent's* edits into the stash, scrambling the tree (session 889: 6 parallel agents
over 28 files → only 12 left modified, the rest stranded in `stash@{2}`). Subagents
don't coordinate git state. **Rules:**

- (a) For multi-subagent batches that edit the tree, either run in isolated
  `git worktree`s (one per parallel *issue/track*) or run sequentially.
- (b) ALWAYS add "do NOT run any git command (stash/reset/checkout/add/commit); only
  edit files" to every parallel build-subagent prompt.
- (c) You CAN run two different *issues* truly in parallel — a frontend track in the
  main tree + a Rust track in a worktree (`git worktree add ../wt-x -b branch origin/main`)
  — since they touch disjoint files and separate `target/`.
- On scramble, don't trust stash provenance: reconstruct and let the full gate
  (oxlint + tsc + full test suite) be the arbiter.

### Merging chained PRs out of order strands commits on orphan branches

When PR-B is opened against PR-A's branch (chained), GitHub's "Merge pull request" on
PR-B merges *into PR-A's branch*, not into `main`. If PR-A has already merged to `main`,
PR-B's merge lands on the now-orphan PR-A branch and **never reaches main** (PR shows
MERGED, but `main` doesn't see the content). Mitigation: merge the chain bottom-up
(oldest first) without skipping levels. Recovery if a later chained PR already shows
MERGED but its content is missing from main: rebase the next-still-open chained branch
onto `main` directly (`git rebase origin/main` drops the already-on-main commits, keeps
the unique ones), force-push, then repoint its base via REST:
`gh api /repos/<owner>/<repo>/pulls/<N> -X PATCH -f base=main`. The `gh pr edit --base`
path is unreliable (GraphQL deprecation warning silently swallows the change) — use the
REST PATCH. Session 843 hit this and recovered.

### Verify HEAD actually advanced after commit

Under rtk, a commit can print "ok N files changed" while a pre-commit hook actually
aborted the commit. Always confirm `git rev-parse HEAD` moved (or `git log --oneline -1`
shows your new commit) BEFORE pushing or opening a PR. A masked abort means you push the
prior commit and the PR is missing your work.

## Lint / format

### `oxfmt --write` detaches `oxlint-disable-next-line` comments — re-run oxlint AFTER formatting

Formatting reflows JSX (splits a multi-attribute tag so each attribute lands on its own
line), moving the line a `-next-line` directive was meant to cover. Some oxlint rules
anchor the diagnostic at the offending attribute's own line, not the opening tag —
notably **`jsx-a11y/prefer-tag-over-role` anchors at the `role=` line**. So a
`// oxlint-disable-next-line … prefer-tag-over-role` above `<div` misses the `role=`
line one row below. And `//` comments are not valid *between* JSX attributes. **Fix:**
wrap the element in a block pair — `/* oxlint-disable jsx-a11y/prefer-tag-over-role -- reason */`
… element … `/* oxlint-enable jsx-a11y/prefer-tag-over-role */` (plain `/* */`, NOT
`{/* */}` which is invalid in a `return (` position). Block disables survive oxfmt
reflow. ALWAYS run `npx oxlint` again after `oxfmt --write` and before committing.

### Don't `oxfmt --write .` / `npm run format` to fix your files

It reformats all TOML in a style taplo rejects → mass unrelated diffs + aborted commit.
Format only your changed files.

## Tests vs semantic changes

### Semantic-tag / role swaps break tests that query the literal attribute

Swapping `<div role="status">` → `<output>` (or `role="region"`→`<section>`) changes the
*implicit* role but removes the literal `role="…"` attribute. Tests using
`container.querySelector('[role="status"]')` or `toHaveAttribute('role', 'status')` then
fail. Before any such swap, grep the matching test for `[role=` / `getByRole` /
`toHaveAttribute('role'` — if the literal attribute is asserted, keep the role and
disable-with-reason instead of swapping. This is why a11y burndowns must run the FULL
test suite (not just touched-file tests) as the gate.

## Rust / sqlx (see also references/codegen-and-sql.md)

### Verify Rust batches with `cargo check --all-targets`, not just `--tests`

`cargo check --tests` / `cargo nextest run` do NOT compile `benches/*.rs`. A cross-cutting
signature/type change (e.g. an IPC param `String`→`BlockId` newtype, session 896) leaves
benchmark call sites passing the old type; lib+tests build clean and a subagent reports
"green", but `cargo check --all-targets` (or CI bench build) fails later. After any such
change, run `cd src-tauri && cargo check --all-targets` before committing and fix bench
call sites (usually a trailing `.into()`).

### The shared `src-tauri/dev.db` must match the CURRENT branch's migrations

The pre-commit/pre-push `cargo clippy` runs sqlx in *online* mode against `DATABASE_URL`
(`sqlite:dev.db`), so `query!`/`query_as!` macros are type-checked against the *live
dev.db schema*, NOT the committed `.sqlx` offline cache. With migration-divergent
branches, `dev.db` ends up at whatever the *last* `sqlx migrate run` left it, and pushing
a *different* branch fails with a backwards trait error like
`Option<String>: From<Option<i64>>` (session 901). `SQLX_OFFLINE=true cargo check` passes
(uses per-branch `.sqlx`), masking it until push. **Fix when switching between
migration-divergent branches:** recreate dev.db from the branch you're about to push —
`cd src-tauri && set -a && . ./.env && set +a && sqlx database drop -y && sqlx database create && sqlx migrate run --source migrations`.
Don't reach for `SKIP_CI_VERIFY=1`.

### Before migrating a timestamp/enum column, grep for cross-table comparisons

Issue #109 Phase 2 (TEXT→INTEGER-ms timestamps) looked like ~10 independent per-table
migrations, but `op_log.created_at`, `block_drafts.updated_at`, and
`attachments.created_at` form a *coupled cluster*: recovery runs `… AND created_at > ?`
binding `draft.updated_at` (a cross-table SQL comparison), and the materializer sets
`attachments.created_at` *from* the op's `created_at`. Migrate only one side and the
comparison silently breaks — SQLite ranks by storage class (INTEGER always < TEXT)
regardless of value, and under `STRICT` a leftover-typed bind hard-fails. Self-generated +
self-compared columns (`link_metadata.fetched_at`, `peer_refs.*`, `materializer_*`) are
safe standalone. Before picking a "table N", grep the column name for `> ?` / `< ?` SQL
predicates against *other* tables and for values flowing from one timestamp into another;
migrate any coupled set in a single PR. Backfill recipe preserving ms precision:
`CAST(ROUND((julianday(col) - 2440587.5) * 86400000.0) AS INTEGER)`, NULL-guarded for
nullable columns.

## Delegation

### Kitchen-sink refactors handed to a single subagent stall or silent-fail

Refactors touching >10 consumer call sites or requiring coordinated edits across many
test fixtures (prop-drill cleanups, hook-extraction sweeps, IPC-wrapper migrations) have
repeatedly stalled or silent-failed when delegated as one unit (sessions 555 / 557 / 558
→ orchestrator-direct close in 559 / 560). For this class: either (a) run it
orchestrator-direct, or (b) split explicitly by file boundary into 3-6 narrow subagents
where each owns ≤6 files and has no cross-cutting test dependency. Do not hand "refactor X
across the codebase" to a single subagent.
