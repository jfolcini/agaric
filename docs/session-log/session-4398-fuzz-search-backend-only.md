# Session 4398 — the conformance fuzz stops comparing the search stub

**What broke:** main's Rust lane went red after #7005. `conformance_fuzz::mock_matches_backend_on_fixed_seed_op_chains_6567` compared its `search` read: the backend returned `["B5"]`, the mock `[]`. #7005 made the mock's search and query engine a stub and listed `search_blocks`, `search_blocks_partitioned`, `run_advanced_query` and `filtered_blocks_query` in `QUERY_COMMANDS_BACKEND_ONLY`. The fuzz's `read_steps` still compared `search` (`search_blocks`) and `advanced` (`run_advanced_query`) between the stacks, and cloned their limit refusals from `LIMIT_CAPS`.

**Why #7005's CI missed it:** `scripts/classify-changes.sh` did not set `rust_tests` for a change under `src/lib/tauri-mock/`. The fuzz's header even said so: a mock-only PR's divergence would show only on the next PR that ran the Rust tests.

**Fix:**
- The fuzz drops the `search` and `advanced` read steps, their `LIMIT_CAPS` entries, and `search_term` with its test and `read_steps`' `term` argument, which nothing else used.
- The classifier sets `rust_tests` for any `src/lib/tauri-mock/` path, and `classify-changes.test.ts` pins it.
- The pre-push phase's `scripts/test-related-rust.sh` maps the same paths to the `agaric` crate, which owns the fuzz.

**Shown red:**
- The fuzz with main's `read_steps` fails on the `search_blocks` divergence (215 cases), and passes without it.
- The classifier test fails with the new line removed.

**Ran:** the fuzz test; `classify-changes.test.ts` (85 passed); `cargo fmt`; the pre-commit and manual-stage hooks on the touched files.
