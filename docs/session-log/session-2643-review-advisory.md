# Session 2643 — the Claude PR review is advisory, runs once per PR, and names no plugin

#5923, with the maintainer's choice 3a (advisory and cheaper).

- **Plugin removed:** `claude-code-review.yml` installed the `code-review`
  plugin, but its slash command came after the SECURITY paragraph, where it is
  never expanded, so the plugin never ran. The prompt now says what the agent
  already did: read the PR with `gh pr view` / `gh pr diff` and judge it by the
  REVIEW POSTURE. The verdict shape is unchanged.
- **`claude.yml` deleted**, and dropped from `_stop-pr-ci.yml`'s exclusion
  regex: the @claude workflow had done nothing since August.
- **Triggers:** a non-draft PR is reviewed when opened, marked ready or
  reopened, and again when the `re-review` label is added; a push alone does
  not re-review. The workflow removes the label first, so adding it again
  starts another review. Markdown-only diffs are skipped (`paths-ignore`,
  allowed because this workflow reports no required context).
- **Concurrency:** a run for any other label is skipped by the job's `if` but
  would still join the PR's group and cancel a live review, so it gets a group
  of its own.
- **Docs:** the AGENTS.md Reviewer line said the ruleset counts the review; it
  now describes it as advisory (the maintainer approved that edit with 3a). The
  batch-issues skill adds `re-review` after a fix push answers a
  changes-requested review.

Ran: `prek run` on every changed file (actionlint and zizmor included) and
`prek run --hook-stage manual --all-files`. The triggers themselves are only
exercised in GitHub: this PR's own open runs the new workflow.
