# Session 1235 — Push-based filing loop for fuzz-lane findings

**Date:** 2026-07-29
**Branch:** `ci/file-fuzz-findings`
**Closes:** #3169

## Summary

The weekly `fuzz` lane's only signal was a red job in a workflow nobody watches — which is
exactly how #3163's compile break (landed 2026-07-24) survived five days. This applies the
`file-mutation-survivors` (#2947) pattern to `fuzz`: the lane now emits per-target machine-
readable results, and a new `file-fuzz-findings` job diffs them against a **single** tracking
issue's last-known set, filing/updating that one issue only when a genuinely NEW finding
appears.

## The change (3 files)

- **`.github/workflows/scheduled-deep-checks.yml` — `fuzz` job: fail-fast → run-all-then-fail.**
  `set -euo pipefail` stays on for the script, but each target's `cargo fuzz run` now runs in a
  guarded subshell whose exit code is captured rather than propagated. Previously the first
  failing target aborted the loop: `snapshot_decode` failed to compile and, being first, cost
  `deeplink_parse` and `import_parse` their runs too — three targets' coverage lost to one
  error, with nothing saying so. Every target is now attempted independently, and the step
  aggregates at the end (`exit "$overall"`), so any non-`ok` target still fails the job — the
  lane is never silently green. Each target writes its OWN
  `fuzz-status/<target>.{status,log,artifacts}` (statuses **pre-seeded to `not_run`**, which
  still means something now that the loop runs to completion: a cancelled/killed job leaves the
  targets it never reached marked `not_run`) plus `targets.txt`, uploaded as a new `fuzz-status`
  artifact (separate from `fuzz-artifacts`, whose multi-path least-common-ancestor layout a
  workspace-root path would have reshuffled). Status vocabulary:
  `ok|build_failed|crashed|timed_out|failed|not_run`, classified by grepping that target's own
  log.
- **`scripts/file-fuzz-findings.mjs`** (new, pure Node built-ins) — turns those files into
  findings: `[build]` (carrying the first compiler error line), `[crash]` (target + reproducer
  hash), `[timeout]`, `[failed]`, `[not-run]`, and a synthetic `[lane]` finding derived from
  `needs.fuzz.result` when the job died before uploading anything at all. Known state lives
  between `<!-- fuzz-findings:begin/end -->` markers in the tracking issue body — no committed
  baseline, so the job needs `issues: write` and never `contents: write`. Finds the one issue by
  exact title (preferring OPEN, reopening a CLOSED one rather than duplicating). No-op gate is
  strictly `newOnes.length === 0`, so a persistent unchanged failure and a purely-resolved week
  both stay silent. `--dry-run` + `--known-body-file` make every path testable without GitHub.
  The body/comment lead with a per-target status table covering **every** target, passing ones
  included, so "N of 5 failed" and which ones is visible at a glance and a skipped target is
  never something a reader has to infer.
- **`file-fuzz-findings` job** — `needs: [fuzz]`, `if: always() && github.event_name ==
  'schedule'`, `permissions: { contents: read, issues: write }`, `continue-on-error` artifact
  download. `if: always()` is load-bearing: the real failure was a compile error, not a crash
  artifact. Schedule-only so a `workflow_dispatch` smoke run can never touch the real issue
  (#2947).

## Verification

`node --check`; YAML parses and the job's `needs`/`if`/`permissions` read back as intended;
`prek run --files` (actionlint + zizmor) clean. A local harness exercised the script against
fabricated result dirs: the real #3163 compile-break shape, idempotent re-run against its own
rendered body (0 new / 0 resolved), crash + timeout + not-run added (only the 3 new ones fire),
everything-fixed (resolved-only → no-op), missing artifact + job failure (`[lane]` finding),
missing artifact + job success (0 findings), and a 400-finding body-clamp check confirming the
marker block survives truncation intact. The workflow's fuzz loop itself was extracted from the
YAML and run with a stub `cargo` on `PATH`: all five targets ran despite the first failing,
producing `build_failed/crashed/timed_out/ok/failed` with overall exit 1 — and that generated
directory was then fed to the script. A second run killed mid-loop (`timeout -s KILL`) left every
unreached target at `not_run`, confirming that state still carries meaning. **Not locally
verifiable:** the real scheduled run — real cargo-fuzz output shapes, the artifact round-trip,
and live `gh issue` calls are CI-only.
