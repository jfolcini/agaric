# PEND-75 — 0.1.37 release bump + tag landed on `fix-pend-74-hastag-flake` (not `main`)

Status: hardening shipped 2026-05-20 (this commit); root cause unproven, tracking for future investigation only.

## Symptom

During the 0.1.37 release session, `scripts/bump-version.sh 0.1.37 --commit --tag --push` produced commit `acc1431e` and tag `0.1.37` on the branch `fix-pend-74-hastag-flake` instead of `main`. PR #42 is open from that same branch, so `_validate.yml` now runs twice on the same SHA — once via `ci.yml` (pull_request event) and once via `release.yml` (push of the tag). ~20–30 GH-Actions minutes wasted per tag-while-PR.

## Reflog evidence

```text
acc1431e HEAD@{0}: commit: chore(release): bump version to 0.1.37
8c6728c4 HEAD@{1}: checkout: moving from main to fix-pend-74-hastag-flake    ← rogue switch
8c6728c4 HEAD@{2}: checkout: moving from main to main                        ← suspicious no-op
8c6728c4 HEAD@{3}: pull --ff-only origin main: Fast-forward
9fe16c79 HEAD@{4}: checkout: moving from pend-69-70-71-search-backend to main
```

HEAD@{1} and HEAD@{2} are "checkout: moving from …" reflog entries — only `git checkout` / `git switch` / `git worktree …` (or equivalent C-level `setup_branch`) produce that text. The user's session log shows none of those commands ran between the pull and the bump-version invocation.

## Investigation (2026-05-20)

Walked the suspect list end-to-end. Cleared:

| Suspect | Verdict | Evidence |
|---|---|---|
| `scripts/bump-version.sh` itself | Clean | grep `checkout\|switch\|worktree` returns zero hits; the script only runs `git rev-parse`, `git status`, `git add`, `git commit -S`, `git tag -s`, `git push --no-verify`. |
| `.git/hooks/pre-commit` (prek wrapper + code-review-graph appendix) | Clean | Line 13 `exec "$PREK" hook-impl …` replaces the process; the code-review-graph block at lines 14-19 is unreachable. |
| `.git/hooks/pre-push`, `prepare-commit-msg` | Clean | Same pattern — immediately `exec` prek; no checkout. |
| `code-review-graph` (`uvx code-review-graph`) | Clean | Source under `~/.cache/uv/archive-v0/.../code_review_graph/` — only shellouts to `git` are `diff`, `rev-parse`, `status`, `ls-files`, `fetch` (eval only), `clone` (eval only), `checkout` (eval/runner.py only, never in `update`/`detect-changes`/`status`). |
| `rtk` (Rust Token Killer) `git` proxy | Clean | `rtk git --help` lists only `diff/log/status/show/add/commit/push/pull/branch/fetch/stash/worktree`. Unknown subcommands like `checkout` pass through verbatim to `git` — they would produce the same reflog entry but the user's session log shows no such command was issued via rtk either. |
| User-level git aliases / `core.hookspath` | Clean | `~/.gitconfig` has only `[user]`, `[core] fsync`, `[checkout] fsync`, `[safe]`. No aliases, no global hooksPath redirect. |
| Project-level git aliases | Clean | `.git/config` only sets `core.hooksPath` to the in-repo default; no aliases. |
| prek hook scripts (`prek.toml` `entry =` shellouts) | Clean | None of them invoke `git checkout`, `git switch`, or `git worktree`. The few that mention "checkout" are doc comments only. |

## Remaining hypothesis (unproven)

The most likely remaining mechanism is the Claude Code harness's worktree management. Evidence:

- `git worktree list` shows a locked Claude-managed worktree at `/home/javier/dev/agaric/.claude/worktrees/agent-a17399f2445df5e86` on branch `worktree-agent-a17399f2445df5e86`.
- The user's branch list includes `worktree-agent-*` and `dependabot/*` branches that don't appear in the session's git command log.
- The `Agent` tool has an `isolation: "worktree"` mode that creates a temporary git worktree; if a worktree-cleanup path doesn't drop its reference to HEAD on the primary working tree, a stale branch switch could leak.

Confirming this would require harness internals (`worktree-agent-*` creation/teardown code path) that aren't readable from this repo. Tracked here as a "watch and act" item; revisit if it recurs after this PR's hardening lands.

## Fix (shipped this commit)

Triple-guard `scripts/bump-version.sh` with explicit `git rev-parse --abbrev-ref HEAD == main` assertions at the three load-bearing moments. Belt and braces — defends against the unknown root cause AND a future regression in whatever upstream automation moved HEAD.

| File:line (this commit) | Guard |
|---|---|
| `scripts/bump-version.sh:106-127` | Entry-point assertion: exits before any mutation if HEAD is not on main when `--commit` is requested. |
| `scripts/bump-version.sh:229-241` | Pre-stage assertion: catches drift between entry-point check and the `git add` / `git commit -S` pair (e.g. manifest edits / biome format / cargo update / PostToolUse hooks the harness may run between subprocess invocations). |
| `scripts/bump-version.sh:282-295` | Pre-tag assertion: this is the load-bearing moment — the 0.1.37 incident manifested as a tag on the wrong branch. If HEAD moved between commit and tag, fail loudly with an explicit diff of the two branch tips. |

Each guard:

- exits non-zero with a clear error message (current branch name + remediation hint),
- runs before any mutating git op (`add` / `commit` / `tag` / `push`),
- is essentially free (one `git rev-parse` per check),
- is independent of root cause (works regardless of how HEAD got moved).

## Why this is the right fix

Three reasons. First, the user-facing contract of the release flow is "land on main, tag main, push main+tag" — every downstream consumer (the `_validate.yml` PR-vs-release split, the release workflow's `verify-version` gate, the GPG `required_signatures` ruleset on `main`, even the `git push --no-verify origin main` line in the script itself) assumes that contract. Asserting it explicitly at script entry encodes the contract in the script's own preconditions rather than relying on the caller's session state being clean. Second, the actual root cause is most likely upstream of this repo (Claude harness worktree management), so even a perfect fix there would still leave the script vulnerable to a future regression or a different upstream automation; the guard is durable across both. Third, the cost is one `git rev-parse` per guard — fork+exec at the speed of every other git command in the script — and the failure mode it prevents (a 20-30 minute wasted CI burn per tag-while-PR plus the manual cleanup of moving the tag to the right branch) is asymmetric in its favor.

## Out of scope (this commit)

- Removing the unreachable code-review-graph block from `.git/hooks/pre-commit`. It's a no-op (line 13 `exec` prevents the rest of the file from executing) and removing it would require regenerating the hook via `prek install` or manual edit; not worth the churn while it's harmless.
- Tracking the Claude harness's worktree-cleanup path. Requires harness internals we can't see; revisit only if the incident recurs.
- A pre-commit hook that asserts branch policy for the `chore(release):` commit shape. Belt-and-braces is enough; an additional hook adds maintenance surface.
