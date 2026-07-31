# Session 1244 — CI and prek hardening: checks that could not fail

Continuation of session 1243's `/loop /batch-issues` run (2026-07-31), after the
maintainer re-scoped the priority mid-session to **prek and CI checks, including
scheduled ones**. Everything below shares one defect class:

> A check that cannot fail is worse than no check, because it reads as green.

## Shipped

- **#3330 / #3257 / #3245** — the frontend mutation lane ran `npm run mutation || true`
  with nothing verifying it produced anything, so a StrykerJS crash, a silently dropped
  module, or an all-compile-error run all finished with a green tick. The bench-smoke shard
  discovery used a `grep -A1 | sed` heuristic that dropped any bench whose manifest key
  order differed — with all four shards still exiting 0, so a bench could fall out of CI
  entirely. The pre-push verifier allocated sqlx probe DBs at a fixed `/tmp` path, so two
  worktrees pushing concurrently clobbered each other. The survivor filer listed every entry
  twice (114 lines for 57 survivors) and would eventually 422 against GitHub's body limit.
- **#3348** — a prek guard banning unanchored regex surgery on user content, motivated by
  #3313 (same session), which corrupted `Notebook shopping list` into `[[id]]book shopping
  list` and whose *first* fix was also wrong because its boundary classes omitted `\p{M}`.
  Existing violations ratchet in a baseline where every entry carries a mandatory reason.
- **#3359 / #3364** — a rolling tracking issue filed when any scheduled lane goes red, plus
  `--require-rust`/`--require-frontend` so the survivor filer can tell a missing artifact
  from an empty one instead of silently deleting the frontend half of its tracked set.

## The recurring finding

In **every one** of these batches, the adversarial reviewer found a check that could not
fail — including inside the fixes themselves:

- The #3330 builder's own first ratchet was **tautological**: it grepped for a literal its
  own grep pattern contained, so it matched itself. Caught by the builder during its own
  before/after run.
- The #3330 reviewer found a **vacuous** bench cross-check *in the fix*: `grep -c` on a
  possibly-missing file, `|| true` swallowing the status, and an empty string comparing as
  `0` in bash arithmetic — so it could never fire regardless of how many benches dropped out.
- The #3348 reviewer constructed a **false negative**: the module-level-constant resolver
  matched `const` at any indentation, so an unrelated same-named local `const` elsewhere in
  the file could inline a genuinely dynamic identifier as static, defeating the rule on a
  shape worse than the bug that motivated the guard.
- The #3359 reviewer found a **blocker-class false green in the last-resort fallback** —
  the layer with nothing beneath it. `set -uo pipefail` without `-e`, both branches ending
  in `echo`, so a failing `gh` left the step green while printing "filed a new issue".
  It also proved caveat (b): all 32 self-test assertions were pure-function assertions, so
  deleting the close path's `gh issue edit` re-introduced a silent-forever bug with a fully
  green suite. Closed with end-to-end `gh`-call-sequence assertions.

The lesson we kept re-learning: **a self-test that passes against regressed code proves
nothing.** Every guard in these PRs now has a fixture that breaks it, and every reviewer
re-broke them independently rather than trusting the builder's report.

## Filed, not deferred

- **#3373** — the highest-value finding. Every guard script gates `main()` on
  `import.meta.url === \`file://${process.argv[1]}\``. `import.meta.url` is the *resolved*
  path; `argv[1]` is the path *as invoked*. Through any symlink they differ, and the script
  **exits 0 having run nothing**. Hit live while building a test harness. Eight scripts
  affected across all three issue filers and the `check-*.mjs` family; the reviewer found
  the `import.meta.filename` variant breaks the same way, and the `file://` form
  additionally breaks on a path containing a space.
- **#3374** — four other scheduled workflows still have no notification path.
  `branch-protection-assert` is the alarming one: silent drift in the control that stops
  unreviewed code reaching `main`.
- **#3359** noted one irreducible gap: if the reporter job never starts, nothing reports.
  A watchdog on an offset cron would close it for every workflow at once — arguably the
  higher-value piece, since it is the only check covering "the checking machinery itself
  did not run".
- **#3360**, **#3361**, **#3362**, **#3364**, **#3369** — residual diagnosis-quality gaps,
  the root-crate sqlx probe still writing to the real dev DB, `interactive_slo` able to fall
  out of both bench lanes, and the regex guard's three unfollowed usage shapes (needs an AST
  scanner, disclosed rather than hidden).

## Non-CI work in the same session

Shipped alongside: **#3324** (a non-HeadExchange first message bypassed the entire sync peer
authorization block, letting an anonymous LAN host trigger a full vault snapshot export),
**#3313/#3314**, **#3320/#3323**, **#3251**, **#3259** (purge unlinked blob bytes that
surviving rows still referenced). Follow-ups **#3352**, **#3353**, **#3355**, **#3356**,
**#3357**, **#3367**, **#3370**, **#3371**.
