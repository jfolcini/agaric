# Session 2606 — just ipc-check, gen-bindings lib-only, and the conformance run narrowed

#5849's local recipes and loop docs. The maintainer approved the root
`AGENTS.md` command changes.

- **`just gen-bindings`** runs `cargo test --lib -- specta_tests --ignored`:
  the test lives in the `agaric` lib, and the bare form also built the bins,
  the three integration binaries and the doc-tests.
- **The conformance regeneration** adds `--test command_integration`, the
  only binary holding `conformance_fixtures_match_backend`, and keeps
  `--workspace` so features resolve as usual. Listing it selects exactly
  that one test.
- **`just ipc-check`:** gen-bindings, the narrowed conformance
  regeneration, `npx vitest run src/lib/tauri-mock`, then the typecheck,
  each the canonical command.
- Every copy of both commands moved with them: root `AGENTS.md`,
  `e2e/AGENTS.md`, `src-tauri/tests/AGENTS.md`, `BUILD.md`,
  `TROUBLESHOOTING.md`, `tooling.md`, `CONTRIBUTING.md`, the PR template,
  `ts_bindings_up_to_date`'s failure message and the three
  `conformance-coverage.test.ts` messages.
- **`BUILD.md` § When to use which loop:** the unmeasured "~10-20 s" is
  gone; `cargo tauri dev` uses the real vault (nothing sets
  `AGARIC_DATA_DIR`) and typechecks on every launch (`beforeDevCommand`);
  a paragraph on iterating a frontend change against the real backend with
  a `devUrl` debug binary and `vite preview` on 5173, and why the final run
  uses the embedded binary.

Ran: the two listings (5m27s to compile the lib test target, 2m39s for
`command_integration`), `cargo fmt --check`, `cargo test --lib --no-run`,
`conformance-coverage.test.ts` (26), prek on every file. `just ipc-check`
itself was only dry-run.

Left on #5849: the stale-binary guard for WDIO and the local one-compile
build in `wdio.conf.ts`.
