# Session 1043 — audit fix #1270: ipc-error-path guard must not pass no-test-file components

2026-06-16. From the 2026-06 Opus quality audit (testing). `/loop /batch-issues` run.

## Bug
`scripts/check-ipc-error-path.mjs` only inspected the CONTENTS of existing test files. An
IPC-calling component with NO test file went into a `skippedNoTest` bucket and was
`continue`d — never a violation, printed only under `CHECK_IPC_VERBOSE=1`, never affecting
the exit code. So the guard fired only for the milder case (test exists but lacks a
rejection assertion) while the severe case (a new component shipped with zero tests that
could silently swallow IPC failures) sailed through CI.

## Fix
- A no-test IPC component is now a hard `exit 1`. The one legitimate exception (error path
  covered via a different test file) is allowed only via an explicit, justified
  `NO_TEST_ALLOWLIST` that **self-prunes** (a stale entry → `exit 1`, so it can't rot into a
  permanent pass). Refactored to a pure `analyze()` + a `--self-test` mode over a synthetic
  fixture tree (no-test→FAIL, covered→PASS, incomplete→violation, allowlisted→PASS,
  stale→FAIL).
- Tightening flagged exactly **5** components — small, so all covered in-PR (allowlist ships
  empty, no follow-up needed): `ActivityFeed`, `HistoryRestoreDialog`, `HistoryRevertDialog`,
  `TagsModeBody`, `AutostartRow`. Each test mocks the IPC call to reject and asserts the
  error path fires (toast / aria-live / optimistic revert) — mutation-verified non-vacuous.
- `prek.toml`: added `ipc-error-path-coverage-selftest` so the guard's own logic is
  regression-tested whenever the script changes (can't silently re-vacuum).

## Verification
Reviewer mutation-verified all 5 tests (swallowing each handler fails its test), confirmed
the self-test's 7 assertions, validated detection (47 IPC components, 0 untested). Guard:
before `OK (5 missing tests)` exit 0 (vacuous) → after `OK: 47 … rejection coverage` exit 0
(honest). Full frontend suite 12743 passed; tsc + oxlint clean.
