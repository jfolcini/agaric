# Session 1127 — baseline cleanliness sweep: clippy + knip green, e2e flake hardened

Full baseline verification of `main` @ `2581359d0` (v0.7.2): ran the complete prek
hook surface, the backend (`cargo nextest`) and frontend (`vitest`) suites, the
Playwright e2e suite, and audited every lint/analyzer exception. Two local-only
quality gates had drifted **red** on `main`; both are fixed here.

## Findings

- **Stale `node_modules` / Node version.** `@opentelemetry/api` (added by the
  observability M-series) was in `package.json` + `package-lock.json` but not
  installed, so `tsc` failed. Root cause: the shell defaulted to Node 22 while the
  repo hard-pins Node ≥24 (`engine-strict=true` in `.npmrc`). Reinstalled under the
  fnm-managed Node 24; not a repo change.
- **`cargo clippy` red.** `cargo clippy --workspace --all-targets -- -D warnings`
  failed with 13 errors in the new `src-tauri/src/observability/*` modules plus
  `src-tauri/src/db/recovery.rs` and `src-tauri/src/sync_protocol/loro_sync.rs`.
  Confirmed independently by the nightly `clippy-clean` job in
  `.github/workflows/scheduled-deep-checks.yml` failing the same day — the per-PR
  `validate` lane does not run full-workspace `--all-targets` clippy, so the
  violations merged unseen.
- **`knip` red.** Unused files, devDependencies, and exports (including newly-added
  observability helpers). `knip` runs in no CI workflow (local pre-push only), so it
  had drifted.
- **e2e:** one genuinely flaky test (`e2e/formatting-toolbar-mobile.spec.ts` — the
  44px touch-floor measurement raced the toolbar's ResizeObserver overflow reflow).
  Four `batch-operations` / `block-paste-outline` multi-select failures reproduced
  locally but are **green in CI** (`validate / playwright` shards 1–3 all passed on
  this commit) — a local-headless artifact, not an app regression, so left untouched.

## Fixes

- **clippy:** `cargo clippy --fix` for the auto-fixable lints (redundant closures,
  explicit auto-deref, uninlined format args); manual `#[allow]` with a bounds proof
  for the intentional `f64`→`u64` cast in `src-tauri/src/observability/sampling.rs`;
  `drop()`→`let _ =` for the non-`Drop` instrument handle in
  `src-tauri/src/observability/metrics.rs`. Full workspace clippy now green.
- **knip:** removed dead exports (`buildTraceparent`, `isFrontendObservabilityInitialized`,
  `compileFlatParams`, `getRegisteredPrefixes`, `_resetRegistryForTests`,
  `_resetFailedOnceForTests`, `hasInjectedError`, `NotifyOptions`, `FilterKind`) and
  their barrel re-exports; configured the genuine false-positives in `knip.json`
  (ambient `.d.ts` files, the `tw-animate-css` CSS `@import`, the `scripts/`-only
  `istanbul-lib-coverage`, and the `taplo` / `rustc` binaries); dropped the stale
  `depcheck` ignore. `knip` now green.
- **e2e flake:** hardened the 44px floor assertion in
  `e2e/formatting-toolbar-mobile.spec.ts` to retry the single-pass measurement via
  `expect(...).toPass()` until the overflow reflow settles (no arbitrary sleep).
  Verified stable 5/5 under `--repeat-each`.

## Filed

- Nightly `bench-compile` lane timing out (>90m) → issue #2122.
- Nightly `fuzz` smoke lane failing (exit 101) → issue #2123.
