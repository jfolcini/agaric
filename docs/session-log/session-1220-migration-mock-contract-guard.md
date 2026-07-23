# Session 1220 — Migration→mock schema-contract guard (#3084)

**Issue:** #3084 (part of umbrella #3082) + activation of 3 staged ratchet scenarios

## Problem

The tag mock read `block_properties(key='space')` — a contract retired by migrations
0087/0088 — and nothing flagged it; #3081 shipped with green e2e against a mechanism the
backend had moved on from. Migrations need a programmatic tripwire on the mock.

## Fix

- **`scripts/check-migration-mock-contract.py`** — for each migration NOT in the
  grandfathered baseline (`src-tauri/migrations-mock-ack-baseline.txt`, all 102 current
  basenames), parse affected tables (CREATE/ALTER/DROP TABLE, TRIGGER…ON, `_new`
  rebuild forms both directions; VIRTUAL TABLE and comments excluded), intersect with a
  self-test-pinned CONTRACT map (9 backend tables → the mock files modeling them), and
  require EITHER a modeling mock file changed alongside OR a literal
  `-- mock-unaffected: <reason>` annotation. The baseline makes pre-commit, pre-push,
  and CI `--all-files` behave identically with zero git dependence — and a migration
  committed with `--no-verify` still fails CI (non-baselined file in --all-files mode).
- **prek.toml** — guard + self-test hooks (files alternation sees migrations AND mock
  files in one invocation).
- **migrations/AGENTS.md** — compact Guard paragraph under the #3086 rule.
- **Part B** — added `scenarios` tags to the 3 #3090 fixtures and uncommented their
  tuples in `conformance-coverage.test.ts` → 15 active required scenarios. The 4th
  staged tuple (`create_block/tag-space-scope`) is retagged per review: a conformance
  fixture is structurally impossible for #3081 (masked by `assign_all_to_test_space`;
  snapshot omits `space_id`) — the tuple is to be REMOVED when #3092 merges, its
  coverage living in the Rust integration test + mock round-trip tests.

## Verification

- Self-test (7 SQL fixtures + CONTRACT integrity + parser cases) pass; `--update-baseline`
  deterministic (byte-identical twice); negative tests: new migration touching `blocks`
  fails without acknowledgement, passes with mock change or annotation; non-baselined
  migration fails in --all-files mode (the CI back-stop, reproduced by reviewer).
- `prek run --all-files` both hooks pass; vitest mock 206/206; coverage test 15 tuples;
  `tsc -b` 0; oxlint clean.
- Adversarial review: SHIP. Confirmed the inverse hole is closed (migration-only commit
  fails), CONTRACT completeness against the mock's actual 10 persistent stores
  (`pageLastModified`/`pages_cache` omission judged defensible — derived cache), self-test
  pin genuinely bites (broken entries fail). LOW theoretical parser gaps flagged
  (`schema.table`, backticks — no migration uses either form).
