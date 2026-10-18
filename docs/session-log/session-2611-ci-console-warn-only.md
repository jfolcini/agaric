# Session 2611 — CI lanes print warnings and errors, and the rest goes to a file

The maintainer's rule: on CI, only warn and error messages reach the
console; info and debug detail lives in files. #5871 did WebdriverIO,
Playwright, nextest and vitest's logger; an audit of one post-#5871 run per
lane found the rest, and each is now quieted by the tool's own switch.

- **Workflow env** (`_validate.yml`, `ci.yml`, `e2e-tauri-weekly.yml`,
  `scheduled-deep-checks.yml`): npm at `loglevel=warn` with no fund or
  audit summary (`npm audit` forces its own), and `PREK_QUIET` where no step
  counts prek's `Passed` lines. Cargo stays at its default level, at the
  maintainer's call: `CARGO_TERM_QUIET` would also drop cargo's own
  warnings (an unused manifest key), and warnings must reach the log. So
  the e2e-tauri steps lose theirs too, and every `CARGO*` environment, and
  with it every rust-cache key, is unchanged.
- **A passing hook's warning cannot hide behind `PREK_QUIET`:**
  `doc-vs-code-paths`' line-past-EOF citation, its one warning that exited
  0, now fails unless `KNOWN_INTENTIONAL_WARNINGS` acknowledges it.
- **Composites:** apt and `install-deps` output to a log printed on failure,
  with the mirror diagnostic; `rustup -q`; `sqlx migrate run` to a log
  printed on failure (its errors are on stdout too, so not `/dev/null`).
- **Reporters and builds:** `node --test` writes a `spec` report to a file
  printed on failure, the vitest merge uses the dot reporter, the vitest
  shards write coverage JSON only, Vite logs at `warn` on CI
  (`vite.config.ts`; its asset listing was about 340 lines a build), and the
  bundler's `-v` output is `tauri-build.log`, printed on failure and
  uploaded, replacing the `grep -v` filter.

Left, with no quiet switch: `taiki-e/install-action`, `setup-android`'s
sdkmanager progress, `actions/cache` and checkout chatter, CodeQL's
collapsed groups, jsdom's "Not implemented" warnings. `release.yml` is
untouched.

Ran: prek on every file; each switch locally, with a failing case still
printing its error (a missing npm script, a tsc error, a rustc warning, a
failing vitest under the dot reporter, a failed migration); the apt and
`install-deps` failure paths with stub commands.
