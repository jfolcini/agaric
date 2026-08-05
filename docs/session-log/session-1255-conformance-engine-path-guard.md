## Session 1255 — Conformance engine-path guard (2026-08-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-05 |
| **Subagents** | 1 build + 2 review |
| **Items closed** | #3333 |
| **Items modified** | — |
| **Tests added** | +0 (frontend) / +2 (backend) |
| **Files touched** | 2 |

**Summary:** Tightened the backend conformance harness so fixture-local SQL/Loro parity
is checked after setup and every settled operation, including fixtures with no
`create_block` operations. The guard preserves exact position checks outside narrowly
tracked purge gaps, verifies property/tag removal and purge cleanup, and replaces stale
command/replay documentation with the current projection paths.

**Files touched (this session):**
- `src-tauri/src/command_integration_tests/conformance.rs` (+609/-86)
- `docs/session-log/session-1255-conformance-engine-path-guard.md` (new)

**Verification:**
- `cargo nextest run --manifest-path src-tauri/Cargo.toml -p agaric -E 'test(conformance_fixtures_match_backend) + test(engine_parity_guard_rejects_sql_only_move_dedent_divergence) + test(set_property_clear_detection_matches_fixture_payload_projection)'` — 3 tests run, 3 passed.
- `cd src-tauri && cargo nextest run --workspace` — 5,475 tests run, 5,475 passed, 6 skipped.
- `cd src-tauri && cargo check --workspace --all-targets` — passed.
- `cd src-tauri && cargo fmt --all -- --check` — passed.
- `git diff --check` — passed.
- pre-commit hook — pending commit.
- pre-push hook — pending push.

**Process notes:** The initial process-global fallback-counter proposal was rejected
because plain `cargo test` can increment that atomic concurrently. Independent review
then drove the fixture-local guard to per-operation checks so later restore/delete/purge
operations cannot erase evidence of an earlier fallback.

**Lessons learned (for future sessions):** A final-state parity assertion is insufficient
for event sequences whose later operations can converge after an incorrect intermediate
path. Guard the operation boundary that owns the invariant, and keep accepted SQL/Loro
representation differences (such as purge-created position gaps and dangling reverse
references) explicit and narrowly evidenced.

**Commit plan:** single commit, then push and open a stacked PR.
