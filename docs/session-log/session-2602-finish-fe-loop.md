# Session 2602 — the local loop's last recipes: test-fe-related, check-fe, check-be

The local-loop items left on #5848 and #5847.

- `scripts/test-related-ts.sh --worktree` selects from uncommitted work
  (staged, unstaged and untracked files against HEAD), as
  `test-related-rust.sh --worktree` does; one pathspec array now feeds every
  source. The script has no self-test: a scratch repo with one file of each
  kind (unstaged, staged, untracked `.mjs`, untracked fixture and its fs
  reader, gitignored, deleted) selected exactly the four expected, and went
  red with the untracked step disabled and with `git diff HEAD` narrowed to
  `git diff`.
- `just test-fe-related`, `just check-fe` (typecheck, lint, related vitest)
  and `just check-be` (fmt check, clippy, related nextest), each step the
  canonical command.
- `src/__tests__/AGENTS.md` rule 8 relaxed as the maintainer approved on
  #5848: locally the related set, or `npx vitest --changed origin/main`,
  stands in for the full suite; CI keeps it.

Ran: shellcheck and prek on the changed files; `just test-fe-related` once
after touching a test file (1 file, 21 tests). `check-be` was only
dry-run.

Left on #5848: the post-#5869 Playwright shard measurement and the shard
decision. Left on #5847: the held build-once `cargo-tests` archive and the
`needs: validate` question, both waiting on #5853's cache work.
