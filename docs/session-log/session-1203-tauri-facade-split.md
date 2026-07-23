# Session 1203 — Split the lib/tauri.ts IPC facade into per-domain modules

**Date:** 2026-07-23
**Branch:** `refactor/tauri-facade-split`
**Closes:** #2902

## Summary

`src/lib/tauri.ts` was a 2,870-line single IPC facade with ~153 named exports (230 total
public names incl. re-exported `bindings` types) imported by ~328 files — the hottest
merge-conflict surface in the frontend. This splits it into per-domain modules behind a
**re-export barrel**, so every existing `@/lib/tauri` import keeps working while edits land in
disjoint files (mirrors the #2931 tauri-mock and #2254 page-blocks splits). Purely mechanical,
behavior-preserving.

## The change

- **17 domain modules** under `src/lib/tauri/` (blocks 24, queries 13, system 13, pages 12,
  history 14, properties 14, sync 14, tags 8, links 8, attachments 9, drafts 7, tasks 5,
  import 5, search 3, core 2, notifications 2, logging 1) — every function/const/type-reexport
  moved **verbatim**.
- **`_shared.ts`** — internal `toSpaceScope`/`requireActiveScope` (never public, NOT
  re-exported).
- **`src/lib/tauri.ts`** — now a 105-line **re-export barrel** (`export * from './tauri/…'` +
  the verbatim `bindings` type / `SafeLimit` / safe-limit value / `unwrap` re-exports),
  preserving the exact public surface.
- Two necessary non-consumer edits from the physical move: `scripts/check-raw-invoke.mjs`
  (exempt `src/lib/tauri/` for the relocated sanctioned `read_attachment` raw invoke, mirroring
  #2931's `tauri-mock/` exemption) and `src/lib/__tests__/platform.test.ts` (path
  `../tauri.ts` → `../tauri/system.ts` where `isMobilePlatform` now lives).

## Cycle avoidance

Barrel → domains → (`@/lib/bindings`, `@/lib/app-error`, `_shared`, `core`, external). **No
domain imports the barrel**, so the graph is acyclic; the one cross-module runtime dep
(`search` → `core` for `withAbort`) points away from the barrel. The import-time side effect
`setLogBackendSink(logFrontend)` (logging.ts) is preserved and still fires (barrel
`export *`s logging; `package.json` has no `sideEffects:false`).

## Verification

Independent adversarial review: **export parity 230 = 230** (zero dropped/added/renamed, zero
cross-module collisions); `tsc -b --noEmit` clean (the real parity enforcer — any missing
export breaks a consumer compile); `check-import-cycles.mjs` **0 cycles** (1500 modules);
Channel/abort/readAttachment/importMarkdown bodies character-identical to origin; NO consumer
import changed; `check-raw-invoke` clean + self-test; `tauri-import-baseline` 209 importers,
no new/stale. Builder ran full `vitest` = 4123 pass; reviewer ran a targeted 30-test runtime
spot-check green. `oxlint` clean.
