# Session 4505 — #7127's review notes, and the test lanes' log noise

**Ask.** Fix every finding, the small ones included: the reviewer's non-blocking notes from both of #7127's reviews. Then read every test lane's CI output (bridge, Playwright, vitest, WebdriverIO, cargo) for warnings and errors that bury real ones, and fix what can be fixed.

**Done: #7127's notes.**
- `errorMessage` (`scripts/lib/error-message.mjs`) replaces the 33 remaining inline copies of `err instanceof Error ? err.message : String(err)`, in 24 scripts. Two copies stay:
  - `file-mutation-survivors.mjs` keeps its own `asError`, because a self-test runs a copy of it beside its one static import.
  - The copy in `check-unanchored-content-regex.mjs` is fixture text, not code.
- `check-dynamic-sql.mjs` and `check-raw-tx.mjs` now import the helper. Their tests copy each guard with the modules it imports (`GUARD_FILES`), so both lists name `lib/error-message.mjs` too.
- `check-doc-code-paths.mjs`'s self-test read an `Error`'s message through `errorMessage` inside its own `instanceof Error` branch; it reads `err.message`. The note named `check-dynamic-sql.mjs`; the line is in `check-doc-code-paths.mjs`.
- `measure-boot.mjs` named its baseline twice, `baselineDir` only to keep a type narrowed inside `boot()`. The argument's destructuring default (`''`) does that, and the usage check still exits on a missing one.
- `tsconfig.json`'s `references` are one object per line again; the one new entry is the only change left there.

**Done: log noise.**
- **Bridge.** Of a shard's 2,310 log lines, 1,310 were warnings, and nearly all were two per app boot: the mock rejects `plugin:updater|check` and `plugin:autostart|is_enabled` by design (#760), and both the mock and the app warned about it.
  - The mock no longer warns of drift for the four plugins it rejects on purpose; an unknown plugin still warns.
  - `isPluginUnavailable` (`src/lib/app-error.ts`) reads Tauri's own rejection, "plugin <name> not found" (`tauri/src/plugin.rs`). The boot update check and `AutostartRow` log it at debug: the plugin is missing on this platform, not failing. Any other failure still warns. On Android this also drops a warning from every Settings visit.
  - The mock answers `plugin:app|version`: the core app plugin is always registered, so the Help card now reads "Up to date (v0.0.0-mock)" where it read "Up to date". `settings-help.spec.ts` asserts the new text.
  - Two real-backend specs now print 3 warnings, all from the trash paths they test.
  - Left: the slow-transaction warnings from test seeding under three workers (the bridge keeps no log file to move them to), the ResizeObserver notices (#3518 chose `warn` for them), and phone specs calling the Android-only release check on a desktop backend.
- **Playwright (mock lane).** Nothing to fix: the CI reporter prints only failures, and a console error already fails its test.
- **vitest.** CI was already near-silent through `--silent=passed-only`; a local run printed about 4,000 lines.
  - `vitest.config.ts` sets `silent: 'passed-only'`, so local runs and the pre-push verify match CI, and the three CLI flags in `_validate.yml` went. A merged `--mergeReports` run honours it too. A full local run now prints 12 lines.
  - `App.test.tsx`'s catch-all stubs answered `get_properties` with an empty page, an object, so `PageHeader` crashed behind its error boundary in passing tests that never saw a header. One `unstubbed(cmd)` fallback answers the flat-list commands with `[]`.
  - `check-migrations-strict.test.ts` pipes the guard's stderr, the one line a passing CI shard printed; the assertion still reads the message from the error.
- **WebdriverIO.**
  - The app's console filter leaves out write contention and queue pressure, which the MCP channel spec's write burst raises on purpose; the file log the diagnostics artifact rescues keeps them.
  - `NO_AT_BRIDGE=1` stops GTK warning at every boot that there is no accessibility bus.
  - The `[sandbox] verified` line printed on every passing session; a failed check still says why in its own timeout message.
- **cargo.** The test steps print almost nothing. The doc-test step takes `--quiet`, a character per test instead of a line. The bench profile's `panic` warning is the accepted one its comment explains.
- Not fixed, for a separate look: an `iroh` "Endpoint dropped without calling Endpoint::close" error and a `reproject_block_properties_from_engine` warning in the two-device sync spec, and command errors for an expected not-found (a poll for a block not synced yet) logged at `ERROR`.

**Ran.**
- `npm run typecheck`: clean. Type-aware oxlint over the changed files: clean.
- `npx vitest run`: 1,148 files pass. Each new branch was shown red: the log-level branch in `AutostartRow` and `useUpdateCheck`, and the rejected-plugin set in the mock.
- `node --test` over every `scripts/**/*.test.mjs`: 257 pass; every script's `--self-test`, 17 of them, matches `main`.
- `settings-help.spec.ts` on the mock lane: 3 passed. Two real-backend specs on the bridge: 3 passed, 3 warnings.
- WebdriverIO did not run here: it needs the release binary and the WebKit driver.
