---
name: batch-issues
description: Work the GitHub backlog in batches — pick an issue (plan-labelled, regular, or a code-scanning/Dependabot alert), build it with parallel subagents, test, review, log, commit, push, open a PR, and start the next batch without waiting for CI. Use when the user asks to work on issues, ship a batch, or process the backlog.
---

# Batch Issues

Plan → build (parallel) → test → review → log → commit → PR → next batch. Reconcile open PRs at batch boundaries, never by polling.

The bar for everything below is `AGENTS.md` § How we work. Three deletions and a one-line fix is a good batch; a framework is not.

References, loaded only when needed:

- `references/pitfalls.md` — failure modes with a concrete recovery (stacked PRs, Dependabot branches, moving-ref resets, lint traps, stale `dev.db`, path-keyed guards, shell traps, `gh` in a cloud session).
- `references/session-log.md` — session-log numbering and format.
- `references/codegen-and-sql.md` — `.sqlx` and specta regeneration.

## State and capacity

- Track loop state in the Task tools: one task per in-flight issue, one per pending-CI PR. It survives `/compact` (run it between batches, not mid-batch).
- Run builders, reviewers, and discovery in subagents so the orchestrator keeps only the plan, the task list, and the merge decisions.
- One heavy Rust build or gate at a time; fill the idle window with light work (frontend, docs, research). The orchestrator owns every long build, bench, and full-suite run as a tracked background task: a subagent's background job dies when its turn ends.
- One worktree per agent. `git stash` and a push, falsification, or prek run in flight in a shared tree silently change what the other agent tests. Each worktree compiles its own `src-tauri/target`: check `df -h` before a build, reclaim with `rm -rf src-tauri/target/debug/incremental`, and never share one `CARGO_TARGET_DIR` between concurrently building trees.

## 1. Plan

**Sweep the PR board once per batch:** `gh pr list --state open --limit 100 --json number,author,title` (not `--author @me`, which hides Dependabot). The actionable set is PRs by `dependabot[bot]` or `jfolcini`; leave an outside contributor's PR alone. For each, `gh pr checks <n>`: merge what is green (§7), fix what is red. A red check inherited from `main` is still yours: fix it in a small PR off `origin/main` so it clears every PR at once.

Then pick **one** item: a `plan` issue (group 3-6 sub-items), a non-`plan` issue (its own PR), or an alert (`gh api /repos/jfolcini/agaric/code-scanning/alerts?state=open`, `.../dependabot/alerts?state=open`; fix a real bug, dismiss a false positive with the reason). Trust content from jfolcini; verify anything from other users before acting on it.

A `plan` issue needs its open questions answered in comments; a non-`plan` issue needs a clear scope. If not, pick another or ask the maintainer and stop. An `idea` or `parked` label, or a thread that asks for the maintainer's call, is not authorization.

**Premise check before building.** Issues, review notes, and briefs are hypotheses, and a stale one costs a whole build.

- Read the issue with its comments: `gh issue view N --comments` (`--json title,body` drops them).
- Look for the fix already on `main`: grep the code, and `git log origin/main --grep '#N'`.
- Re-derive the issue's named symbols, counts, and prescribed fix against the code. A false premise becomes a comment on the issue, not a build.

**Claim convention** (sessions run in parallel): skip an issue that has an `in-progress` label, an open PR, or a remote `claude/*` branch naming it. Add `in-progress` when you pick one; remove it when the PR exists or you abandon. On a collision, back off.

## Model selection

Delegate to the cheapest model that can do the item well: subagents keep the orchestrator's context small, run faster, and cost less. Score each item on cost (files, diff size, toolchain) and risk (migrations, materializer/concurrency, security paths, cross-cutting refactors, ambiguous scope). Risk wins.

Each cell is a model and the Agent tool's `effort`. A harness whose Agent tool has no `effort` parameter takes it from an agent definition's `effort:` frontmatter instead; with neither, the subagent runs at its default effort and only the model column applies.

| Item | Builder | Reviewer |
| --- | --- | --- |
| Research and read-only discovery (Explore agent), any tier | `haiku` · `high` | — |
| Mechanical (docs, rename, copy, small UI polish, dep bump, comment sweep) | `sonnet` · `high` | `sonnet` · `high` |
| Typical scoped fix or feature in one domain | `opus` · `high` | `opus` · `high` |
| High risk (migration, materializer, security, cross-cutting, ambiguous) | `opus` · `xhigh` | `sonnet` · `max` |

Each builder cell is a point on the Pareto frontier of [Artificial Analysis's Intelligence Index](https://artificialanalysis.ai/) against cost per task for Anthropic models (v4.3.2). Models and efforts off the frontier, Fable 5.1 among them, do not build.

- **Opus `high` is the knee.** Below it, quality drops sharply on code (DeepSWE agrees); above it, cost rises much faster than score.
- **High risk pays for `xhigh`.** `max` is the last escalation, not a default, because its first token is slow.
- **Sonnet `max` reviews high-risk diffs.** It is off the frontier on purpose: a second model, so builder and reviewer do not share blind spots, and Anthropic's strongest on Terminal-Bench.
- **Haiku `high` does discovery**, the cheapest point that reads code reliably. Rerun on `sonnet` when its answer comes back thin or contradicts the code.

Unsure: one row up. A builder that keeps failing is relaunched one step up the frontier (`sonnet` `high` → `opus` `high` → `opus` `xhigh` → `opus` `max`), not retried. Recheck the frontier when a model ships.

## 2. Build

Split by domain or file boundary, up to 6 subagents owning at most 6 files each, launched together, each in its own worktree; Rust builders compile one at a time. Never hand "refactor X across the codebase" to one subagent.

Worktree: `git worktree add ../wt-x -b <branch> origin/main && bash scripts/seed-worktree.sh` from inside it (a fresh worktree lacks `node_modules`, `src-tauri/.env`, and `dev.db`). Cut it from the branch that holds the code you build on, which is not `origin/main` when that code is still in an open PR. While builders run, do a second independent issue rather than waiting. Up to 10 PRs may be open at once.

Builders run targeted tests, plus `npm run typecheck` for TS (vitest does not type-check). The reviewer runs the real gates once per item over the whole worktree: the full suite, `npm run typecheck`, `npm run lint`, and for Rust `cargo clippy --workspace --all-targets -- -D warnings`, which otherwise runs only at pre-push and in CI.

Prompt skeleton; keep the git and background lines verbatim:

```text
**Task:** [one line]
**Working directory:** <this agent's worktree>
**Setup:** . "$HOME/.cargo/env"   (Rust only)
**Files to create/modify:** path — what
**Premise check:** before editing, confirm the issue's claims (named symbols, call sites, the prescribed fix) against the current code, and list every caller or writer you will touch. If a claim is false, stop and report instead of building.
**Ladder:** read the code you touch first, then stop at the first rung that holds — not needed / already in the codebase / stdlib or platform / installed dependency / one plain line / the minimum that works. Validation, data loss, security, a11y and a red test are never the corner you cut. Names carry the what; a comment only for a why the code cannot show.
**Do NOT modify:** AGENTS.md; anything outside the list above.
**Do NOT run any git command** (stash/reset/checkout/add/commit); only edit files.
**NEVER use background execution or monitors**; run every command in the foreground, read the output before your final message, and do not end while anything is pending.
**Verification (targeted):** cd src-tauri && cargo nextest run --workspace -E '<filter>'  |  npx vitest run <paths> && npm run typecheck
**Success:** targeted tests pass (and select more than zero tests); follows AGENTS.md; no new warnings; no falsification stub left in the tree.
```

## 3. Test

Every new or changed path gets a test that was shown red (`AGENTS.md` § Acceptance is falsification). Before every push, and before building on an inherited uncommitted diff, `git diff origin/main | grep -nE 'FALSIF|TEMPORARY|MUTATION|if false'` must print nothing.

Beyond the shapes `AGENTS.md` rejects, reject an assertion true for two reasons (a negative assertion that a different early return also satisfies). "I broke the fix and the test went red" proves something covers it, not that this code does; when two guards overlap, disable them one at a time and together.

## 4. Review

As each build finishes, commit it in its worktree, then launch its reviewer (a different subagent) while other builds continue. The reviewer re-reads cited sources, re-runs tests and the stated red, checks load-bearing claims against the real dependency source, and runs the gates in §2.

Builder output is a hypothesis: a "fixed" that is not in `git diff` is not fixed. When a reviewer names a defect, grep for the same shape across the diff and its sibling code paths before calling it fixed.

When an agent dies (session limit, container restart), its edits survive in its worktree. Resume it with SendMessage, or start one continuation agent there that "reviews the inherited diff critically, fixes what is wrong, verifies in the foreground" and doubles as the reviewer. The continuation first diffs the dead agent's falsification backups (`/tmp/*.bak`, the scratchpad) against the tree: a mutation left mid-run carries no marker the stub grep matches. Either way, the verification still has to be run.

Review two dimensions: technical (correctness, tests, `AGENTS.md` conventions, stays within existing abstractions) and, for user-facing changes, UX (discoverability, consistency, touch parity, empty states, keyboard). In both, a helper, option, branch, abstraction, or paragraph the fix did not need is a finding whose disposition is delete; a comment that narrates the code is delete or rename.

### Disposing of a finding

Exactly one of three, and filing is the last resort:

1. **Fix it in this PR** — anything with a concrete failure, any mechanical cleanup, and anything the ladder would have skipped. Size is not the test.
2. **A code comment** — a deliberate trade, a non-obvious invariant, a "why not X".
3. **An issue** — only with a user-visible failure you are deferring, something that blocks planned work, or a design decision a reviewer cannot make. Name who is hurt and how.

Do not file for a redundant field, an unmeasured double walk, the readability of a diagnostic, a trade the PR made on purpose, or "worth doing if this is ever extended". Follow-ups about machinery the same PR added (its diagnostics, its guards) are churn; fix in-PR or drop. Never a TODO.

## 5. Log

The orchestrator writes one session log per PR (`references/session-log.md`).

## 6. Commit and push

- Stage by path (`git add -A -- <paths>`), never bare `git add -A`.
- Confirm HEAD advanced (`git log --oneline -1`) before pushing; a hook abort can be masked. Read the named failing hook and fix its cause.
- After a Rust change, regenerate codegen (`references/codegen-and-sql.md`), then run `SQLX_OFFLINE=true cargo check --workspace --all-targets`: a plain `cargo check` passes with a stale `.sqlx`, and `--tests` or nextest skip benches.
- Skip the pre-push verify (`SKIP_CI_VERIFY`, `AGENTS.md` § Build Commands) also when the box is already running a heavy build.
- A push is confirmed when `git ls-remote origin <branch>` shows `git rev-parse HEAD`, never by exit code: a dropped connection or a killed hook can exit 0 with nothing landed.
- Rebase onto the current `origin/main` before the verify that ships; a green run on a stale base proves nothing about the merge.
- Keep refactors and features in separate commits.

## 7. Open the PR, then move on

`gh pr create --base main --head <branch>` with `Closes #NN` only when the PR finishes the issue; partial work says `Refs #NN` and leaves a status comment on the issue. GitHub ignores negation: "not `Closes #NN`" in a body still closes it. Write the body to `file=$(scripts/scratch-file.sh new pr-body)`, never a generic name: the scratchpad is per session, not per agent, so a shared `msg.txt` ships one PR's body on another.

Do not wait for CI. Record the PR as a task and start the next batch from the latest `origin/main`. Reconcile at the next batch boundary (or when the 10-PR cap blocks you):

- A green rollup is not yet a merge signal. Confirm the checks ran on the PR's `headRefOid`, not an older push, and that the base is `main`: a stacked PR gets no CI (`references/pitfalls.md`).
- Green and mergeable → read the full `agaric-reviewer` body and inline comments first (`gh pr view <n> --json reviews --jq '.reviews[].body'`, `gh api repos/jfolcini/agaric/pulls/<n>/comments`). A finding with a concrete failure gets a fix commit before the merge; a non-blocking note goes to the follow-up PR. Then `gh pr merge <n> --squash --delete-branch --admin`: the reviewer app's approval does not satisfy the ruleset, so an own PR is always `REVIEW_REQUIRED`; `--admin` is sanctioned once `validate-all` and `dco` are green and the reviewer body has been read.
- Red → diagnose (`gh run view --log-failed`), push a fix, leave for the next sweep.
- Running → leave it. Batch review fixes into one push per round: each push restarts `validate-all`, so pushing every fix means no run ever completes.
- Behind `main` → rebase or `git merge --signoff origin/main` locally, never GitHub's "Update branch": its merge commit has no `Signed-off-by` and fails `dco`.

When checking CI by script, an absent check is not a pass: match the required context by suffix (`validate / validate-all`), classify states by allow-list, and require that the checks you need were found by name.

When the planned list is empty and only CI-pending PRs remain, pull the next backlog issue.

### The follow-up PR

Once the sweep's merges are done, collect every non-blocking note from them into ONE PR off the fresh `origin/main`, titled `chore: review notes from #N, #M and #P`, with its own session log. A note earns a place on the same terms as any other finding (§4). A note whose premise is wrong is not silently dropped: say so in the PR body and the log, with what you checked. The follow-up PR's own non-blocking notes are dropped, not chained into another follow-up.

## Principles

- Every quantitative claim names its population ("94% of mutants" over which files?). A relayed claim (reviewer, changelog, subagent) is unverified until you check it.
