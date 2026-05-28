## Session 854 — CI cargo-tests disk cleanup (PR #159 fix) (2026-05-28)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-28 |
| **Subagents** | orchestrator-only |
| **Items closed** | — |
| **Items modified** | PR #159 (unblocks the cargo-tests check) |
| **Tests added** | — |
| **Files touched** | 1 |

**Summary:** Follow-up to session 853. The `validate / cargo-tests` job on PR #159 (run 26569299876, job 78272043133) failed with `System.IO.IOException: No space left on device` — surfaced via the check-run annotations API (the log blob was already GC'd by the time the failure was inspected, so neither `gh run view --log` nor `gh api .../jobs/<id>/logs` returned anything; only `gh api .../check-runs/<id>/annotations` carried the actual error). The `cargo-llvm-cov`-instrumented compile plus the rust-deps Swatinem cache restore exhausts the stock ubuntu-24.04 free space. Added a "Free disk space on runner" step at the top of the `cargo-tests` steps list that deletes the preinstalled .NET / Haskell / Android / Swift / Boost / Powershell / hosted-tool-cache trees (none of which this job uses), with `df -h` logged before+after so any future tightening can size against measured numbers rather than a guess.

**Files touched (this session):**
- `.github/workflows/_validate.yml` (+20 — new `Free disk space on runner` step in the `cargo-tests` job)

**Verification:**
- Locally: `cd src-tauri && cargo nextest run --profile ci --no-fail-fast` — 4016/4016 pass on this branch (one flake on `command_integration_tests::block_integration::deleted_blocks_excluded_from_list_blocks`, passes on retry under the `retries = 2` profile-ci setting). Confirms the failure was infra, not the code under test.
- YAML parses (`python3 -c "import yaml; yaml.safe_load(...)"`).
- pre-commit + pre-push hooks will run on commit and push.

**Process notes:** The fix is workflow-only; no Rust or TS code changed. The decision to inline the rm list (rather than pull in `jlumbroso/free-disk-space`) follows the existing convention in this repo of SHA-pinning every external action — adding a fresh dependency for one job was the wrong shape when seven hard-coded paths reclaim what we need. Also intentionally left the comparable `mcp-tests` and `lint` siblings alone: only `cargo-tests` runs the coverage-instrumented build, so only it has the elevated disk footprint to mitigate.
