# Session 1000 — stricter linters (tsc + oxlint + clippy)

Tightened the frontend and Rust linters using a **verify-each-rule** approach:
every candidate rule was applied in isolation, `--fix` run, and `tsc`/tests
checked before keeping it. Rules whose autofix breaks the build or changes
behavior were excluded with reasons. Also confirmed release 0.6.6 (draft) and
dismissed two false-positive code-scanning alerts.

## PRs

- **#1873** — `chore: stricter tsc + oxlint`. Three tsc flags (`noImplicitOverride`,
  `allowUnreachableCode:false`, `allowUnusedLabels:false`); 21 verified-safe
  auto-fixable oxlint rules (343-file mechanical diff); 5 manual rules (`no-shadow`
  ~108, `no-map-spread` ~33, `prefer-set-has`, `prefer-array-find`,
  `jsx-no-constructed-context-values`); refactored the 9 `complexity`-over-25
  functions below the limit (incl. `SortableBlockInner` 47→22). Verified: oxlint
  0/0, `tsc -b` 0, vitest 14054 pass.
- **#1875** — `chore(clippy): enable 17 auto-fixable pedantic lints`. Verified:
  `cargo check`, `clippy -D warnings`, `cargo fmt`, nextest (4544 pass).

## Rules excluded after verification (autofix unsafe / low value)

- oxlint `no-useless-undefined` / `no-useless-promise-resolve-reject` — strip
  semantically-required args (132 TS errors).
- oxlint `prefer-code-point` — `charCodeAt`→`codePointAt` breaks surrogate-pair
  detection in `matcher.ts`.
- oxlint `jsx-curly-brace-presence` — corrupts strings with backslash escapes
  (`{'\\frac{'}` → `"\\frac{"`); caught by the KatexMath tests on the full run.
- oxlint `prefer-default-parameters` — type-changing, low value.
- oxlint `require-post-message-target-origin` — false positive; all sites are
  `Worker.postMessage` (no `targetOrigin` arg).
- clippy `must_use_candidate` — would add `#[must_use]` to ~259 fns, risking
  `unused_must_use` cascades at call sites; `wildcard_imports` — churny.

## tsc 7 evaluation

`@typescript/native-preview` (`tsgo`) typechecks the project and agrees with `tsc`
under the strict flags; ~7× faster (3.4s vs 24.8s). Recommended as a separate
follow-up PR (not done this session).

## Follow-ups

- #1874 — enable oxlint `eqeqeq` (468 manual, `== null` semantics) in its own PR.
- Migrate `tsc -b` → `tsgo` in the prek hook + CI.

## Note

A subagent ran a `git stash` in the shared checkout during the parallel runs and
swept up an unrelated concurrent session's work (`backlink/query.rs`, `i18n/common.ts`,
based on commit `84894fb0`) into `stash@{0}: stray-merged-dupes-from-subagent-misnav`.
Left intact for recovery (`git stash pop` in the right checkout). Lesson: parallel
subagents must never `git stash` in a shared tree.
