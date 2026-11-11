# Session 3706 — build only the lib tests for the MCP stub-binary smoke

The last item of the slow-test sweep. `mcp-tests` runs the three `stub_binary_` tests with `cargo nextest run --features ci-smoke`, which builds every test target of the `agaric` package with that feature, the integration-test binaries included. All three tests live in the lib target. `--lib` builds only that target and selects the same three: `cargo nextest list` with and without it gives the same three names. Locally, with the lib tests already built under `ci-smoke`, the other targets took another 51 s to compile; the step has about 239 s of compile in CI. `mcp-tests` is not on `validate-all`'s long pole, so this saves runner time per Rust PR, not wall time. The manual command in `src-tauri/Cargo.toml`'s comment on `ci-smoke` gains the same flag.

Gating the three tests at runtime instead of on a feature would avoid the separate lib rebuild altogether, but it edits existing test code, so the coordinator left it alone.

Ran: `node scripts/prepare-external-bins.mjs --profile dev` then `cargo nextest run --lib --features ci-smoke -E 'test(stub_binary_)'` (3 passed).
