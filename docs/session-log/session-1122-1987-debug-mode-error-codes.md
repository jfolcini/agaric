# Session 1122 — #1987 debug-mode error codes + correlation IDs

Motivated by an Android sync-pairing failure that surfaced only an opaque toast.
Investigation showed two layers destroy the actionable signal: the backend's
`sanitize_internal_error` rewrites every infra error (`Io`/`Database`/`Channel`/
`Internal`/`Migration`/`Snapshot`/`Json`) to the literal string
`"an internal error occurred"` *before it leaves Rust*, and the frontend then
collapses whatever's left into a generic message. A frontend-only toggle could
never recover what Rust already threw away — so the fix pairs a UI toggle with an
always-on backend correlation id.

## What shipped

### 1. Backend — always-on correlation IDs (`src-tauri/`)

- `commands/mod.rs::sanitize_internal_error` now generates a short id
  (`new_error_id` → 5 uppercase hex, `RngExt::random_range`), logs the full
  original error + source at **`tracing::error!`** keyed by `error_id`, and embeds
  the id in the user-facing copy: `an internal error occurred (err: 7F3A2)`.
- The id travels **inside `message`**, not a new wire field — deliberately, to keep
  the `{ kind, message }` envelope and its specta binding unchanged (mirrors the
  existing "validation codes live in the message prefix" philosophy in `error.rs`).
- MCP's separate `INTERNAL_ERROR_WIRE_MESSAGE` path is untouched (different,
  agent-facing surface).
- Tests: new `sanitize_internal_error_tests` module (id shape; internal variants
  collapse + carry an id with no raw detail leak; user-facing variants pass
  through). The two `*_sanitizes_database_errors` property tests now assert the
  generic prefix + a closed `(err: …)` suffix instead of exact-string equality.

### 2. Frontend — debug toggle + single formatter

- **`stores/useDebugStore.ts`** — persisted (`agaric:debug`, localStorage) flag,
  **off by default**, with a `getDebugMode()` non-hook getter for plain modules.
- **`lib/error-display.ts`** — `formatErrorForDisplay(err, { debug })`, the single
  formatter: plain strings pass through verbatim; Errors / IPC `AppError` objects
  get the cosmetic Rust `Xxx error:` prefix stripped; the `(err: <id>)` code is
  preserved in **both** modes; **debug on** appends `· code: <kind>`.
- **`lib/notify.ts`** — `notifyError` routes structured Error / IPC values through
  the formatter. Because the `no-direct-sonner-import` prek chokepoint already
  forces every production toast through `notify.ts`, **every error toast honours
  the toggle by construction** — no per-call-site change or new lint required.
- **`components/settings/DebugModeRow.tsx`** — `ToggleRow` in the General tab;
  i18n `settings.debugMode.*`.
- Inline (non-toast) banners for the motivating surfaces now use the formatter:
  `PairingDialog` ("Pairing failed: …") and `DeviceManagement` (sync / rename).

### Behaviour

```
toast (debug off): "Pairing failed: an internal error occurred (err: 7F3A2)"
toast (debug on):  "Pairing failed: an internal error occurred (err: 7F3A2) · code: invalid_operation"
log (always):      ERROR error_id=7F3A2 error=<full AppError + source> internal error suppressed…
```

The Android pairing case is now diagnosable: the user reads back `7F3A2`, an
operator greps the daily log for the full cause (mismatch vs mDNS vs TLS).

## Scope notes / deferred

- "Every **toast** respects the choice" is structurally guaranteed by the existing
  sonner chokepoint + the `notify` change. Inline `setError` banners have no single
  chokepoint; the motivating ones were converted, and the remaining ~30 are a
  mechanical follow-up using the same `formatErrorForDisplay` helper. A lint to
  force banners through the helper is left as follow-up (low-precision to express).
- Deeper "humanise validation codes when debug is off" (code→i18n mapping) is out
  of scope; today the default view shows the message minus the Rust prefix.

## PR #1992 review follow-ups

- **Store JSDoc** corrected: the formatter lives in `error-display.ts`, not
  `app-error.ts` (two stale references in `useDebugStore.ts`).
- **DeviceManagement fallback regression**: swapping to `formatErrorForDisplay`
  dropped the context-specific copy for non-`Error` throws (`"Failed to rename"` /
  `"Sync failed"` became `String(e)` → `"undefined"`). `formatErrorForDisplay`
  now takes an optional `fallback` used only for unrecognised throws; the two call
  sites pass their original copy. Covered by new `error-display` tests.

## Flaky-test fix (no test left to rot)

A full-suite `cargo nextest` run flagged one flaky test:
`materializer::handlers::apply_reproject_proptest::b4_two_peer_snapshot_exchange_converges_sql`.
Root cause confirmed via the run log: **not** an assertion failure — TRY 1 was
*terminated* under full-suite CPU contention (the test runs ~30s even alone, and
the global `2×30s=60s` terminate window is too tight under load), then the retry
passed. The test is correct and deterministic with no internal wall-clock
assertion, so the fix is headroom, not trimming coverage: a `.config/nextest.toml`
override gives the heavy apply-reproject proptests a longer leash (default
`4×30s=120s`, CI `3×60s=180s`). The same override covers
`perf26_draft_recovery_at_10k_ops_is_fast` (~50s of 10K-op setup, sitting just
under the 60s kill — a latent flake). Re-running the full suite afterwards:
**4592 passed, 0 flaky, 0 failed** (B4 and perf26 now merely `SLOW`, not killed).

## Verification

- FE: full `vitest run` — 615 files / 14260 tests green; `tsc -b` clean; `oxlint`
  clean on changed files. New tests: `error-display` (incl. fallback),
  `useDebugStore`, `DebugModeRow`, and `notify` debug-mode cases.
- BE: `cargo nextest` (offline sqlx) — new sanitize tests + all 33 `sanitiz*`
  tests (incl. the two updated property tests) green; full suite 4592 passed /
  0 flaky across two consecutive runs after the timeout override.
