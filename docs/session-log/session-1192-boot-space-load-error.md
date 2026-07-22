# Session 1192 — Surface boot-time space-load failures instead of hanging

**Date:** 2026-07-22
**Branch:** `fix/boot-space-load-error`
**Closes:** #2921

## Summary

When `listSpaces()` failed (or legitimately returned zero spaces) during boot, the
app could hang on a perpetual loading state: `boot()` had no way to distinguish a
hard load failure from a usable snapshot, and `page-blocks.ts` `load()` left
`loading: true` when `currentSpaceId` was `null`, so a tree mounting in that window
was stuck forever.

## The change

- **`src/stores/space.ts`** — `refreshAvailableSpaces` now records a
  `SpaceRefreshOutcome` (`'ok' | 'soft-error' | 'hard-error'`) on a new
  `lastRefreshOutcome` field. Classification: a failure is **hard** only when there
  is no usable snapshot to fall back on
  (`hasUsableSnapshot = availableSpaces.length > 0 || currentSpaceId !== null`);
  otherwise **soft**. Every path (non-array guard, success, catch) ends in `set(...)`
  — the function never rejects (contract relied on by `void refreshAvailableSpaces()`
  callers in `SpaceSwitcher.tsx` / `SpaceManageDialog`).
- **`src/stores/boot.ts`** — reads `lastRefreshOutcome` after the refresh and sets
  `state: 'error'` on a hard failure, routing to BootGate's error screen (with a
  retry that unconditionally re-invokes `boot()`). Overwrites the outcome on every
  call, so no stale-error state can wedge a retry.
- **`src/stores/page-blocks.ts`** — the `currentSpaceId == null` early return in
  `load()` now also clears `loading`, covering both the empty-success and
  null-currentSpaceId cases (a refresh that legitimately returns zero spaces). This
  is the fix for the perpetual-loading hang.
- **`src/lib/i18n/errors.ts` / `common.ts`** — new keys `error.spacesLoadFailed`,
  `boot.spacesLoadFailed`.
- **`src/components/layout/SpaceSwitcher.tsx`** — unchanged control flow; the
  never-rejects contract keeps its `void refreshAvailableSpaces()` safe.

## Tests

- `src/stores/__tests__/space.test.ts` — HARD outcome (no snapshot → error, still
  resolves), SOFT outcome (usable prior snapshot: non-empty `availableSpaces`, OR
  persisted `currentSpaceId` with empty list → stays ready).
- `src/stores/__tests__/boot.test.ts` (new) — hard failure sets `state:'error'`;
  retry re-runs `boot()` and clears the error.
- `src/stores/__tests__/page-blocks.test.ts` — `spaceId == null` load clears
  `loading`.

Non-tautological: breaking each of the three fixes (hard/soft classification,
loading-clear, outcome-read) individually fails its dedicated test. Full run
1433/1433 pass; `tsc -b --noEmit` + `oxlint` clean.
