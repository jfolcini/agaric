# Session 1217 — Real-backend WebdriverIO smoke as a weekly job

**Issue:** #155

## Problem

Every e2e spec (~111 Playwright specs) runs against the JS Tauri **mock**, never the real
Rust backend + real WebView. The mock can silently drift from backend behavior (e.g. the
`create_block` page_id divergence fixed in session 1217's conformance work). #155 asks for a
real-backend e2e path. Running it on every PR is too slow/flaky (WebKitWebDriver + xvfb +
a full `--debug` Tauri build), so it belongs on a schedule.

## Fix

A WebdriverIO + `tauri-driver` harness that boots the actual built binary and drives the
real WebView, wired as a **weekly** (non-blocking) job:

- **`wdio.conf.ts`** — `tauri-driver` on port 4444, binary `src-tauri/target/debug/agaric`,
  mocha framework. `beforeSession` spawns / `afterSession` reaps `tauri-driver`; a
  shutdown guard (`shuttingDown` flag before `.kill()`) covers exit/SIGINT/SIGTERM/SIGHUP
  so intentional teardown doesn't trip the `exit`-handler's `process.exit(1)`.
  `WDIO_SKIP_TAURI_BUILD=1` in CI (the workflow builds separately).
- **`e2e-tauri/smoke.e2e.ts`** — boots the app, waits for `[data-slot="sidebar"]` + the
  Journal nav item, creates a block via the real editor, and asserts the committed block
  renders as `[data-testid="block-static"]` containing the typed marker (round-trips through
  the real backend). (Reviewer corrected the assertion from a non-existent
  `sortable-block` testid to `block-static`.)
- **`tsconfig.wdio.json`** — isolated; NOT referenced by the app `tsconfig.json`, so `tsc -b`
  never pulls the wdio files into the app bundle.
- **`.github/workflows/e2e-tauri-weekly.yml`** — `schedule: '17 4 * * 1'` + `workflow_dispatch`
  only (NO `pull_request`/`push`), ubuntu-24.04, `timeout-minutes: 45`, apt
  `webkit2gtk-driver xvfb` + Tauri deps, `cargo install tauri-driver --locked`, SHA-pinned
  actions matching `_validate.yml`, `permissions: contents: read`, `persist-credentials: false`.
- **`package.json`/`package-lock.json`** — `@wdio/*` ^9 + `@types/mocha` + `tsx` devDeps;
  `test:e2e-tauri` / `typecheck:e2e-tauri` scripts. **`knip.json`** — `@wdio/local-runner`
  added to `ignoreDependencies` (knip's WebdriverIO plugin auto-detects the rest but not the
  `runner: 'local'` value).

## Non-blocking guarantee

Triggers are `schedule` + `workflow_dispatch` only; the job (`e2e-tauri`) is not in
`branch-protection-assert.yml`'s required contexts (`dco`, `validate-all`) and nothing in
`ci.yml`/`_validate.yml` `needs:` it. It can never gate a PR.

## Verification

- `npx tsc -b` → exit 0; `npx tsc -p tsconfig.wdio.json` → exit 0.
- `npx oxlint` → exit 0; `npx knip` → exit 0.
- Adversarial review confirmed: SHA pins byte-identical to existing workflow pins, minimal
  permissions, no injection surface, gate-safe (never blocks PRs), and validated the smoke
  selectors against the real components (`ui/sidebar.tsx`, `AddBlockButton`,
  `EditableBlock.tsx`, `StaticBlock.tsx`).

## First-run residual risk (human to confirm on first scheduled/dispatch run)

The whole harness is unrun locally (no webkit/display here). Highest risk: the "Add block"
CTA selector requires an active space with today's journal auto-created; a freshly-seeded
backend with no active space shows a different "Add your first block" CTA. Trigger via
`workflow_dispatch` once to confirm before relying on the weekly cadence.
