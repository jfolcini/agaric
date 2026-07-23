# Session 1200 — Split the tauri-mock handlers monolith into per-domain modules

**Date:** 2026-07-23
**Branch:** `refactor/tauri-mock-handlers-split`
**Closes:** #2931

## Summary

`src/lib/tauri-mock/handlers.ts` was a 5,142-line single file holding the ~140-key
`HANDLERS_TYPED` command map — the browser/test mock IPC backend that reimplements backend
semantics (op-log, revert simulation). The `satisfies TypedHandlers` linkage against
`bindings.ts` + `scripts/check-tauri-mock-parity.mjs` enforce handler PRESENCE/shape, but
the single file was a contention point for every backend-surface PR. This splits it into
per-domain modules — purely mechanical, behavior-preserving.

## The change

- **10 domain modules** under `src/lib/tauri-mock/handlers/`: `blocks.ts` (23),
  `pages.ts` (17), `tags.ts` (9), `links.ts` (8), `history.ts` (14), `search.ts` (5),
  `properties.ts` (23), `sync.ts` (21), `attachments.ts` (7), `system.ts` (13) — **140/140
  command keys preserved**, zero duplicates/gaps.
- **`handlers/shared.ts`** — the stateless cross-domain helpers, types, and
  `TypedHandlers`/`Handler` types.
- **`handlers.ts`** is now a thin barrel that imports and spreads the 10 domain slices into
  the single `HANDLERS_TYPED satisfies TypedHandlers`, preserving the exact public surface
  (`dispatch`, `HANDLERS`, `PLUGIN_HANDLERS`, `RAW_RESPONSE_HANDLERS`, and the re-exported
  `PageMetaRow`/`metaRowMatchesFilter`/`metaRowMatchesExpr`/`compareMetaRows`/
  `encodeNextCursor`), so no consumer/test import changes.
- **`scripts/check-tauri-mock-parity.mjs`** now scans all `handlers/*.ts` domain files
  (excluding `shared.ts`) instead of the single inline literal.

## Shared state — no duplication

The mutable stores (`blocks`, `opLog`, `properties`, `propertyDefs`, `blockTags`, …)
already live as a singleton in `seed.ts`; every domain module imports them directly from
there (ES-module caching → exactly one instance). `seed.ts`/`index.ts`/`injection.ts`/
`revert.ts` are **byte-identical to origin/main** — the reset/seed-between-tests hooks are
untouched, so cross-test state semantics are unchanged.

## Verification

Reviewer diffed **all 140 handler bodies** against origin/main: 138 byte-identical; 2
benign (an extraction artifact, and one same-module sibling self-reference
`HANDLERS['find_undo_group']` → `historyHandlers['find_undo_group']` resolved via closure).
`tsc -b --noEmit` clean (the `satisfies` linkage is the type gate); parity **140/140**;
oxlint clean (one pre-existing complexity warning, confirmed identical on main). Full
`npx vitest run` passed **15468/15468** on origin/main and twice on the split branch — the
one full-suite `AgendaView` failure the builder saw did not reproduce in three runs and is
an unrelated order-flake (that test mocks all its deps and never touches tauri-mock).
