# Session 4449 — the real-binary lane becomes the smoke lane

#6926's final CI/docs PR, after smoke groups 1 to 4 (#7012, #7077, #7078, #7080) folded the real-binary specs into about a dozen smoke specs. It follows the maintainer's 2026-11-18 decisions 2 to 4.

- **Cadence:** `e2e-tauri-weekly.yml` runs nightly at its old off-peak minute, still ahead of `scheduled-deep-checks`. It still runs on every release tag, through `release.yml`'s call. On a PR, `e2e-tauri-gate` always reports, and the lane runs only when the diff touches what only the binary shows. `scripts/classify-changes.sh`'s `real_backend` set is narrowed to section C's classes:
  - capabilities and `tauri.conf.json`;
  - the Tauri stack's manifests;
  - the sync daemon and transport;
  - MCP and its sidecar;
  - the mirror;
  - boot and recovery;
  - the maintenance daemon;
  - media capture;
  - the lane's own files.

  A frontend-only change still runs the bridge lane (`pw_full` → `bridge`), which is decision 2's per-PR real-backend check.
- **One shard.** The matrix, `--shard`, `wdio.conf.ts`'s spec dealing, `e2e-tauri/spec-durations.json`, `scripts/e2e-tauri-durations.mjs` and `deal-specs.test.ts` are deleted; one leg runs every spec.
- **Watchdog:** `check-workflow-liveness.mjs` now expects the lane every 24 h.
- **Docs, section F as approved:**
  - `e2e-tauri/AGENTS.md` gets the new intro.
  - Root AGENTS.md § Pre-commit & CI gets one clause for `e2e-tauri-gate`.
  - Rules 4 and 5 and `e2e/AGENTS.md`'s bridge paragraph already carried the wording.
  - Copies that called the lane weekly, per-PR or four-sharded are fixed in the workflows and docs.
- **From the 2026-11-19 list:**
  - `e2e-tauri/AGENTS.md`'s two-device rule now names `sync-two-device.e2e.ts`.
  - The empty `SPECS_WITH_A_SLOW_MATERIALIZER` and its paragraph are deleted.
  - `rename-invalidation.spec.ts` keeps its synthesised `emitMockEvent`. Without it the ref-title test failed 3 of 3 on the bridge, because a command's own event is a local commit's and reloads no page store. It now has a one-line why.

**Ran:**
- `src/__tests__/classify-changes.test.ts`: 128 passed. It covers every class running the lane, and frontend-only and out-of-set Rust paths not running it. The red: narrowing `src/(mcp|mirror)/` fails exactly the MCP case.
- The liveness and e2e-related node tests.
- `npx vitest run e2e-tauri`.
- Both e2e typechecks.
- The pre-commit and manual-stage hooks on the changed files.
- `rename-invalidation.spec.ts` on a locally built bridge: 6 passed.

**Still open on #6926:** `spaces.e2e.ts` has one portable test left, and it needs a bridge port. `settings-tasks-reminders` stays off the bridge, because the bridge cannot move the backend's clock.
