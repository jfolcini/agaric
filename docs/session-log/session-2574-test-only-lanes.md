# Session 2574 — test-only diffs run only the lanes they can affect, and Playwright on four shards

**Gap:** #5853 § "Run only what a test-only change can affect": the classifier
treated a test file like product code, so a vitest-only diff started
Playwright and the real-backend lane, and an `e2e/` spec started the whole
vitest suite. #5848 asked for Playwright on four shards to shorten the
critical path (slowest of three shards ~466 s). Both refs, neither closed by
this PR alone: #5853 keeps its capacity items, #5848 its local-loop items.

**Classifier (`scripts/classify-changes.sh`):** each frontend lane now sees a
path as nothing it reads, one of its own specs, or anything else (run whole).
- A `src/**/*.{test,spec}.ts(x)` file runs the whole vitest suite (its
  coverage gate is a whole-suite number) and no Playwright or real lane.
- `e2e/` starts no vitest. Specs alone set `playwright_specs` to the changed
  specs still on disk; `e2e/helpers.ts` or any other non-spec runs every shard.
  More than 20 specs also run every shard, since the list runs on one leg and
  a sweep would hold it past `globalTimeout`.
- `e2e-tauri/` non-specs set `vitest_e2e_tauri` (`npx vitest run e2e-tauri`,
  four files, no coverage) instead of the sharded suite; helpers and other
  shared modules also run every real-backend spec; `*.test.ts` there runs no
  real lane. Specs alone set `real_backend_specs`.
- Shared test infrastructure stays product code: `src/test-setup.ts`,
  `src/__tests__/{mocks,helpers,fixtures}/**`, `src/lib/tauri-mock/**` (test
  files there included), and the three runner configs run every lane whole.
- A deleted spec is never listed; a diff of deleted specs alone runs no lane.
  The classifier checks the file on disk, so it must run from the repo root
  with the head checked out, as every workflow already does.
- Fail-closed is unchanged: an unrecognized path, or a diff that cannot be
  computed, runs every lane whole with empty spec lists.

**Workflows:** `_validate.yml` gains `vitest-e2e-tauri`, gated in
`validate-all` like its siblings (skip allowed only when
`vitest_e2e_tauri` is false; pinned true when the classifier fails). The
`playwright` matrix is `[1, 2, 3, 4]`, or `[1]` running the listed specs when
`playwright_specs` is set, so a one-spec PR takes one slot and never has an
empty shard. `e2e-tauri-weekly.yml` passes each listed spec as `--spec`
(wdio resolves it against the cwd). The weekly `full-suite-playwright` moved
to four shards too, so `playwright.config.ts`'s "both lanes run the same
shard" comment stays true.

**Verified:** `classify-changes.test.ts` 49 tests green; eleven classifier
mutants (narrowing a vitest test file, dropping the infra exclusion, the two
existence checks, the 20-spec bound, each `*_full` stick, the
`vitest_e2e_tauri` exclusivity) each turned the predicted test red. The
`validate-all` script, extracted and run with a hand-written `needs` JSON,
fails a skipped `vitest-e2e-tauri` when the category is set and passes it when
not; deleting its `check_job` line makes the first case pass. `npx playwright
test --list` shows four shards of 325 tests and a two-spec list of 10 tests.
`prek run --files` (actionlint, zizmor, shellcheck, tsc, oxlint) and the
manual-stage classifier hooks pass.

**Check in this PR's first CI run** (it touches the classifier, so every lane
runs whole):
- `playwright (1)`…`(4)`: the slowest shard's test step against ~466 s, and
  the wall time from `detect-changes` start to `validate-all` end against the
  ~8.5–8.8 min critical path of three shards. Four shards should take about
  three quarters of the test step each; the setup per shard does not shrink.
- Flakes: count any test red on one run and green on a rerun of the same
  commit; the issue wants the flake count next to the timing.
- `vitest-e2e-tauri` is `skipped` and `validate-all` reports it as allowed.
- e2e-tauri `detect` prints `real_backend_specs=` empty.
To see the narrowed lanes, a later spec-only PR should show one
`playwright (1)` leg naming its specs, no vitest jobs, and `validate-all`
green.
