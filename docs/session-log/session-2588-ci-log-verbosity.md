# Session 2588 — CI logs cut to what a failure needs

The WebdriverIO job logged every WebDriver command at `logLevel: 'info'`: 290k of
the lane's 294k lines. A sweep of one passing log per job type found the same shape
elsewhere: a line per passing test (nextest, Playwright), the linuxdeploy plugin
output of `cargo tauri build -v`, accepted Android licence texts.

**Changed**
- `wdio.conf.ts`: `logLevel: 'warn'`. A failure still prints through the spec reporter
  and the `afterTest` diagnostics, which are `console.warn` and independent of the
  level; the app log is rescued from the sandbox as before. `--logLevel=info` on the
  command line brings the wire log back.
- `playwright.config.ts`: under `CI`, `[['dot'], ['github']]`. Nothing downstream read
  the `list` output; the failure artifacts are `test-results/`.
- `src-tauri/.config/nextest.toml` `[profile.ci]`: `status-level = "leak"`,
  `final-status-level = "flaky"`. Failures (full output), retries, SLOW and LEAK print as
  they happen; a test that needed a retry stays in the closing summary.
- `ci.yml` `build`: `cargo tauri build -v` keeps `-v`, but the linuxdeploy plugin
  stdout is filtered from the live log, tee'd to `tauri-build.log`, and a failing build
  prints the whole file in the next step.
- `ci.yml` `android-build`: `log-accepted-android-sdk-licenses: false`.
- `e2e-tauri-weekly.yml`: `CARGO_TERM_QUIET` on the job.
- `_validate.yml`, the vitest shard and merge steps: `--silent=passed-only`. A failing
  test's own logger output still prints; passing tests' does not.
- `apt-install` action: `apt-get install -qq`, about 700 lines of unpack and setup
  progress per Rust job; errors still print.

**Failure signal kept (shown by mutation, restore by backup/trap/`cmp`)**
- Playwright, `CI=1`: one spec assertion changed; output `··F`, then the full error,
  locator, call log and code frame, a `::error` annotation and a one-line summary.
- nextest, `--profile ci`: one pinned vector in `agaric-core` changed; three `TRY n FAIL`
  blocks with stdout and the panic message, the three passing tests print nothing.
- vitest: `--silent=passed-only` with one failing test; the failing
  test's own `console.error` and its assertion diff print, the other tests' logger
  output does not.
- WebdriverIO could not be run here (needs the real debug binary under Xvfb); reasoned
  from the config: the spec reporter and `afterTest` do not depend on `logLevel`.

**Not changed**
- `RUST_LOG` for the app: the stderr and file layers share one filter, so quieting the
  boot cache-rebuild lines (about 2,600 per run) would also thin `agaric.log`, which the
  rescue uploads and which the materialized-view specs need.
- `codeql.yml`: the extractor's per-file lines have no input; the only lever
  (`CODEQL_ACTION_EXTRA_OPTIONS`) cannot be tried without a run.

**For `_validate.yml` and the shared actions (owned elsewhere, not edited)**
- Both vitest steps: add `--silent=passed-only`. The merge step replays every passing
  test's logger output from the blobs (683 entries in the sampled log). Locally a
  four-file merge went from 282 lines to 19.
- `.github/actions/apt-install/action.yml`: `sudo apt-get install -y -qq "${pkgs[@]}"`
  (172 packages x 4 progress lines in every Rust job). Errors still print.
- `package.json` `build`: `tsc -b && vite build --logLevel warn` (the asset listing is
  about 340 lines per build, in eight builds per full run). The bundle-budget gate reads
  `dist/`, not the output.
- Minor: `node --test --test-reporter=dot` in `lint`; `cargo test --doc -q`.
