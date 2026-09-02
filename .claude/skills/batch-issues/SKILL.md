---
name: batch-issues
description: Work the GitHub backlog in batches — pick an issue (plan-labelled, regular, or a code-scanning/Dependabot alert), build it with parallel subagents, test, review, log, commit, push, open a PR, and start the next batch without waiting for CI. Use when the user asks to work on issues, ship a batch, or process the backlog.
---

# Batch Issues

Plan → build (parallel) → test → review → log → commit → PR → next batch. Reconcile open PRs at batch boundaries, never by polling.

The bar for everything below is `AGENTS.md` § How we work: pragmatic, simple, no speculative work, no gold-plating. A batch that ships three small real fixes beats one that ships a framework.

References, loaded only when needed:

- `references/pitfalls.md` — failure modes with a concrete recovery (git stash across subagents, chained PRs, Dependabot branches, worktree seeding, stale `dev.db`).
- `references/session-log.md` — session-log numbering and format.
- `references/codegen-and-sql.md` — `.sqlx` and specta regeneration.

## State and capacity

- Track loop state in the Task tools: one task per in-flight issue, one per pending-CI PR. It survives `/compact` (run `/compact` between batches, not mid-batch).
- One heavy Rust build or gate at a time; a second one ENOSPCs or gets OOM-killed silently. Fill the idle window with light work (frontend, docs, research), not a second cargo build.
- Run per-issue builders, reviewers, and discovery in subagents so the orchestrator keeps only the plan, the task list, and the merge decisions.

## 1. Plan

**Sweep the PR board once per batch:** `gh pr list --state open --limit 100 --json number,author,title` (not `--author @me`, which hides Dependabot). The actionable set is PRs by `dependabot[bot]` or `jfolcini`; sight but do not touch an outside contributor's PR. For each actionable PR, `gh pr checks <n>`: merge what is green (after reading the reviewer's body, §7), fix what is red. A red check inherited from `main` is still yours: fix it in a small PR off `origin/main` so it clears every PR at once. Do not re-poll between checkpoints.

Then pick **one** item: a `plan` issue (group 3-6 sub-items), a non-`plan` issue (its own PR), or an alert (`gh api /repos/jfolcini/agaric/code-scanning/alerts?state=open`, `.../dependabot/alerts?state=open`; fix, or dismiss with a reason). Trust content from jfolcini; verify anything from other users before acting on it.

Before starting: a `plan` issue must have its open questions answered in comments; a non-`plan` issue must have a clear scope in the body or thread. If not, pick another or ask the maintainer and stop. A code-scanning alert is either a real bug (fix) or a false positive (dismiss with the reason, or remove the trigger).

**Claim convention** (sessions run in parallel): skip an issue that has an `in-progress` label, an open PR, or a remote `claude/*` branch naming it. Add `in-progress` when you pick one; remove it when the PR exists or you abandon. On a collision, back off.

Use a read-only Explore agent for discovery (`docs/FEATURE-MAP.md`, `docs/features/*.md`).

## Model selection

Delegate to the cheapest model that can do the item well: subagents keep the orchestrator's context small, run faster, and cost less. Score each item on cost (files, diff size, toolchain) and risk (migrations, materializer/concurrency, security paths, cross-cutting refactors, ambiguous scope). Risk wins.

| Item | Builder | Reviewer |
| --- | --- | --- |
| Mechanical (docs, rename, copy, small UI polish, dep bump, comment sweep) | `sonnet` | `sonnet` |
| Typical scoped fix or feature in one domain | `opus` | `opus` |
| High risk (migration, materializer, security, cross-cutting, ambiguous) | `fable` | `fable` |

Tiers follow Artificial Analysis's Anthropic provider page: Opus 5 scores within a few points of Fable 5.1 on its intelligence index at roughly half the price, and Sonnet 5 at a third of Opus's. Unsure: one tier up. A builder that keeps failing is relaunched one tier up (`sonnet` → `opus` → `fable`), not retried. Research and read-only discovery go to `sonnet` (Explore agent) regardless of the item's tier.

## 2. Build

Split by domain or file boundary (one Rust, one frontend, or one per non-overlapping feature), up to 6 subagents, launched together. Each prompt names: the working directory; `. "$HOME/.cargo/env"` for Rust; the exact files to touch and what to do; what not to touch; the targeted verification command (`cd src-tauri && cargo nextest run --workspace -E '<filter>'` or `npx vitest run <paths>`); and these two lines verbatim:

- "Do NOT run any git command (stash/reset/checkout/add/commit); only edit files."
- "NEVER use background execution or monitors; run every command in the foreground, read the output before your final message, and do not end while anything is pending."

Builders run only targeted tests; the reviewer owns the one full-suite run per item. Nobody runs prek, clippy, or formatters by hand.

While builders run, do a second independent issue rather than waiting: in a separate worktree (`git worktree add ../wt-x -b <branch> origin/main && bash scripts/seed-worktree.sh` from inside it) if files overlap or it needs its own git state, otherwise in the main tree. Up to 10 PRs may be open at once.

Subagent prompt skeleton:

```text
**Task:** [one line]
**Working directory:** /home/javier/dev/agaric
**Setup:** . "$HOME/.cargo/env"   (Rust only)
**Files to create/modify:** path — what
**Ladder:** read the code you touch first, then stop at the first rung that holds — not needed / already in the codebase / stdlib or platform / installed dependency / one plain line / the minimum that works. Validation, data loss, security, a11y and a red test are never the corner you cut. Names carry the what; a comment only for a why the code cannot show.
**Do NOT modify:** AGENTS.md; anything outside the list above.
**Do NOT run any git command** (stash/reset/checkout/add/commit); only edit files.
**NEVER use background execution or monitors**; run every command in the foreground and read the output before your final message.
**Verification (targeted):** cd src-tauri && cargo nextest run --workspace -E '<filter>'  |  npx vitest run <paths>
**Success:** targeted tests pass; follows AGENTS.md; no new warnings.
```

## 3. Test

Every new or changed code path gets a test: Rust happy + error path in `#[cfg(test)]` (fixtures in `src-tauri/tests/AGENTS.md`); frontend render + interaction + `axe(container)` (`src/__tests__/AGENTS.md`).

**A test must be shown to fail.** Break the code it covers, run it, read the red output, restore. Do it against a copy (`cp f /tmp/f.bak`; mutate; run; restore; `cmp f /tmp/f.bak`), never in place: a stub left by an interrupted run has shipped three times. Run `git diff` before the final message.

Reject these shapes in review: an assertion that restates the precondition the test set up; a branch that cannot be taken (delete the code); one arm of a symmetric pair pinned and the other open (including a guard body without its call site); an assertion true for two reasons (a negative assertion that a different early return also satisfies). "I broke the fix and the test went red" proves something covers it, not that this code does; when two guards overlap, disable them one at a time and together.

## 4. Review

As each build finishes, launch its reviewer (a different subagent) while other builds continue. The reviewer re-reads cited sources, re-runs tests, checks load-bearing claims against the real dependency source, and runs the one full-suite pass. When a builder dies mid-verification, one continuation agent "reviews the inherited diff critically, fixes what is wrong, verifies in the foreground" and doubles as the reviewer.

Two dimensions when a change has user-facing impact: technical (correctness, tests, `AGENTS.md` conventions, stays within existing abstractions) and UX (discoverability, consistency, touch parity, empty states, keyboard). Skip UX for backend-only changes.

In both, the reviewer reads the diff against the ladder: a helper, option, branch, abstraction, or paragraph the fix did not need is a finding whose disposition is delete. A comment that narrates the code is one too; its disposition is delete or rename. The diff is the evidence, not the builder's report of it.

### Disposing of a finding

Exactly one of three, and filing is the last resort:

1. **Fix it in this PR** — anything with a concrete failure, any mechanical cleanup, and anything the ladder would have skipped. Size is not the test.
2. **A code comment** — a deliberate trade, a non-obvious invariant, a "why not X".
3. **An issue** — only with a user-visible failure you are deferring, something that blocks planned work, or a design decision a reviewer cannot make. Name who is hurt and how.

Do not file for a redundant field, an unmeasured double walk, the readability of a diagnostic, a trade the PR made on purpose, or "worth doing if this is ever extended". Follow-ups about machinery the same PR added (its diagnostics, its guards) are churn; fix in-PR or drop.

## 5. Log

One file per session at `docs/session-log/session-NNNN-<slug>.md`; never edit a merged one (corrections go in the new session's log). Numbering and shape: `references/session-log.md`. Update `docs/FEATURE-MAP.md` when user-facing features change.

## 6. Commit and push

- Run the formatters on your changed files first (`cargo fmt`; `npx oxfmt --write <files>`, never `oxfmt --write .`), then commit once. If a hook still rewrites a file, re-stage and retry.
- Stage by path (`git add -A -- <paths>`), never bare `git add -A`.
- Confirm HEAD advanced (`git log --oneline -1`) before pushing; a hook abort can be masked. Read the named failing hook and fix its cause. Pre-commit hooks always run (file-scoped, seconds).
- The pre-push verifier is scoped to the push range and classifies it like CI. Let it run for a Rust or frontend range you have not otherwise verified. Skip it with `SKIP_CI_VERIFY='<reason>' git push` when it would only repeat what CI runs on the PR anyway: a docs, CI or tooling-only range, a re-push after a review nit, or a range whose full suite the reviewer subagent just ran. CI is the merge gate; the hook is a convenience, and a box already running a heavy build is a reason on its own.
- After a Rust change, regenerate codegen (`references/codegen-and-sql.md`) and verify with `cargo check --all-targets`. Doc-comment-only Rust changes still regenerate `src/lib/bindings.ts` (`just gen-bindings`, backgrounded: it exceeds the 10-minute foreground limit).
- `SQLX_OFFLINE=true cargo check --workspace` is the check CI runs; a plain `cargo check` passes with a stale `.sqlx`.
- Push with `scripts/push.sh` for anything touching `.rs`.

## 7. Open the PR, then move on

`gh pr create --base main --head <branch>` with `Closes #NN`. Write the body to a unique scratch path (`file=$(scripts/scratch-file.sh new pr-body)`), never a generic name; the scratchpad is shared across concurrent agents.

Do not wait for CI. Record the PR as a task and start the next batch from the latest `origin/main`. Reconcile at the next batch boundary (or when the 10-PR cap blocks you):

- Green and mergeable → read the full `agaric-reviewer` body and inline comments first (`gh pr view <n> --json reviews --jq '.reviews[].body'`, `gh api repos/jfolcini/agaric/pulls/<n>/comments`); an approval with findings is not "nothing to address". Fix quick in-scope findings in a new commit; otherwise dispose of them per §4. Then `gh pr merge <n> --squash --delete-branch --admin`: the ruleset requires one approving review and the reviewer app's approval does not count, so an own PR is always `REVIEW_REQUIRED`; `--admin` is sanctioned once `validate-all` and `dco` are green and the reviewer body has been read.
- Red → diagnose (`gh run view --log-failed`), push a fix, leave for the next sweep.
- Running → leave it.

When checking CI by script, an absent check is not a pass: match the required context by suffix (`validate / validate-all`), classify states by allow-list, and require that the checks you need were found by name.

When the planned list is empty and only CI-pending PRs remain, pull the next backlog issue.

## Principles

- Three deletions and a one-line fix is a good batch.
- Fix what is there. Do not refactor beyond scope. Keep refactors and features in separate commits.
- Out-of-scope improvements become a code comment or an issue per §4, never a TODO.
- Every quantitative claim names its population ("94% of mutants" over which files?). A relayed claim (reviewer, changelog, subagent) is unverified until you check it.
