# Session 2612 — the classifier skips lanes that cannot see a change

The maintainer asked for the smart test selection to stop paying for files
that cannot matter. An audit replayed the classifier over 399 main commits
and 63 PRs with each lane's median cost: about 1,950 of 31,750
runner-minutes went to lanes that could not observe the change.

- **`ci` only:** the `justfile` (nothing in CI runs `just`), `.editorconfig`
  and `.vscode/` (read only by lint's oxfmt). `.gitattributes` and
  `.gitignore` stay unplaced: the first sets `eol=lf` on shell scripts and
  `-text` on two corpora, the second decides which files Tailwind's source
  scan and knip read (ignoring `src/components/` shrinks the main CSS and
  turns knip red), and `lint` runs knip only for `frontend`.
- **Rust lint-only:** benches (all `test = false`, so `cargo llvm-cov
  nextest` never builds them; clippy `--all-targets` in lint does), the fuzz
  workspace, `clippy.toml`, `deny.toml`, `osv-scanner.toml`,
  `.cargo/{audit,mutants}.toml`, the guard baselines and allowlist, two guard
  scripts, `.env.example`. They set `backend` (lint's Rust half) but not the
  new `rust_tests`, which gates `cargo-tests`, `cargo-coverage` and
  `mcp-tests`; `validate-all` skips those only when `rust_tests` is false.
  The rest of `.cargo/` is not lint-only: `config.toml` sets the linker for
  every build.
- **Rust test data is test-only:** `nextest.toml`, `snapshots/*.snap`,
  `proptest-regressions/`.
- **CodeQL by extension:** a non-code file under `src-tauri/` or `scripts/`
  no longer starts a language; main still analyses all three.
- **Under-selection fixed:** `playwright-setup` runs Playwright, and
  `sqlx-offline-check` the backend half of lint, which no change to either
  composite did before.
- **Dropped:** adding the session-log guards to `docs-lint`. Both read only
  the staged index, so under CI's `--all-files` they check nothing in `lint`
  either.

Ran: `classify-changes.test.ts` (79, from 48), each new rule shown red;
`validate-all`'s script over hand-written results, including the hole a
deleted skip rule would open; `verify-ci-equivalent.sh --self-test`;
shellcheck; prek on every file.
