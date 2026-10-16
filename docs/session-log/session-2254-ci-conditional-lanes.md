# Session 2254 — CI skips the lanes a PR cannot affect

The maintainer approved running only the lanes a change can affect. Today's
real-lane spec PRs (#5658, #5660) and Rust-test-only PRs (#5655) each paid for
every lane.

**One classifier.** The changed-path logic moved out of `_validate.yml` into
`scripts/classify-changes.sh`. It now drives three workflows:
`detect-changes` (and through it `ci.yml`'s bundle jobs), `codeql.yml`'s
language pick, and the real-backend workflow. It adds four outputs:

- `playwright` and `vitest` are false when every path is docs or a real-lane
  file. A changed e2e-tauri helper still runs vitest, because
  `helpers.test.ts` tests it.
- Build and real-lane relevance ignore files that compile only under
  `cfg(test)`. A module walk confirmed every file the pattern matches is gated
  that way. `src/commands/tests/` is `cfg(any(test, feature = "test-util"))`,
  so it stays outside the pattern.
- `codeql_languages` picks the changed languages on a PR. Push, schedule and
  dispatch still analyze all three, as the maintainer approved.
- A docs path, `AGENTS.md` and skill files under `src/` and `src-tauri/`
  included, sets no other flag. Nothing reads Markdown at build or test time,
  and the lessons PR (#5661) had been running every Rust and real-lane job.

**The real lane always reports.** It now runs on every PR. A detect job
decides relevance, and an always-run `e2e-tauri-gate` reports the verdict. The
ruleset is unchanged, so the gate is not yet required (#4671).

**Fail-closed.** All of these run everything:
- no base, or an unreachable base;
- a failing `git diff`;
- an empty diff;
- any path the script cannot classify.

`git diff` now runs with `--no-renames`. A rename used to be listed only by its
new name, so moving `src/x.ts` to `docs/x.md` read as docs-only. That gap
predates this change.

**Review.** A second model reviewed the change and fixed five things:
- `e2e-tauri-gate` accepted a skipped lane when `real_backend` came back empty.
  After an output rename, every PR's lane would have stopped running with the
  gate still green. The gate now requires an explicit `false`.
- The failing-`git diff` branch had no test.
- The real-lane trigger list had no tests. Each of its mutations now reds the
  predicted row.
- `index.html` picked no CodeQL language, though the JavaScript extractor reads
  HTML.
- The docs-path rule above.

Parity check: the old inline classifier and the script agree on every
tracked path and on random multi-path sets, except for the intended changes.

Gates: the classifier's vitest file, prek at both the commit and the manual
stage (actionlint, zizmor, shellcheck), `npm run typecheck` and knip.
