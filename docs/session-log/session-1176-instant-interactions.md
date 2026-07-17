# Session 1176 — Instant-interaction polish batch (#2851 / #2852 / #2853)

## Scope

Three cohesive, frontend-only interaction-responsiveness issues shipped as one PR.
All three make already-available state paint sooner (or let the user tune how soon),
without touching data, stores, op types, or sync — squarely inside AGENTS.md →
Architectural Stability (additive UI). Each was built in an isolated worktree by a
`sonnet` builder and reviewed by a separate `sonnet` reviewer (no self-reviews).

## Changes

### #2851 — tooltip hover-open delay preference

A device-scoped preference for the app-wide tooltip open delay, mirroring the existing
`MOTION_PREFERENCE` contract exactly.

- `src/lib/preferences.ts` — `TooltipDelay = 'instant' | 'fast' | 'default'`,
  `ALL_TOOLTIP_DELAYS` allowlist, `TOOLTIP_DELAY_PREFERENCE`
  (`key: 'agaric-tooltip-delay'`, `scope: 'device'`, `defaultValue: 'default'`,
  allowlist-validated `parse`, bare-string serialize), registered as
  `PREFERENCES.tooltipDelay`.
- `src/hooks/useTooltipDelay.ts` (new) — `TOOLTIP_DELAY_MS` map
  (`instant:0 / fast:150 / default:300`), `useTooltipDelay()` (hook) and
  `getTooltipDelayMs()` (non-hook), both reading the same source.
- `src/main.tsx` — new `AppRoot` wrapper component calls `useTooltipDelay()` and renders
  `<TooltipProvider delayDuration={delayMs} skipDelayDuration={delayMs}>`, replacing the
  hard-coded `300`. The intentional per-surface overrides (sidebar `0`, toolbars `200`,
  gutter `500`) set `delayDuration` on their own `<Tooltip>` and are untouched.
- `src/components/settings/AppearanceTab.tsx` — new "Tooltip delay" `Select` next to the
  Animation-speed control; `src/lib/i18n/settings.ts` — 5 new `t()` keys.
- Tests: `src/hooks/__tests__/useTooltipDelay.test.ts`,
  `src/components/settings/__tests__/AppearanceTab.test.tsx` (new).

### #2852 — layout-shaped skeletons for the last full-view spinners

Four whole-view / whole-block centered `Spinner` loads converted to shaped
`LoadingSkeleton` (reused primitive; keeps `role="status" aria-busy="true"`):

- `src/components/AdvancedQuery/AdvancedQueryView.tsx` — initial-load spinner →
  `LoadingSkeleton count={5} height="h-10"` (mirrors `QueryResultList`); refetch path
  (prior results dimmed + `aria-busy`) untouched. Removed now-unused `Spinner` import.
- `src/components/query/QueryResult.tsx` — embedded static-query-block spinner →
  `count={3} height="h-8"`. Removed unused `Spinner` import.
- `src/components/dialogs/PairingDialog.tsx` — QR-shaped + entry-row placeholders,
  label text kept. Removed unused `Spinner` import.
- `src/components/peers/PairingEntryForm.tsx` — lazy QR-scanner Suspense fallback →
  scanner-viewport-shaped placeholder. `Spinner` import kept (still used by the inline
  Pair-button indicator, out of scope).
- Tests updated in each component's `__tests__/` (skeleton present / spinner absent).
  The `PairingEntryForm` Suspense-fallback test is placed first in its block because
  `React.lazy` caches its import promise at module scope.

### #2853 — command palette: paint local/recent matches before FTS returns

Decoupled *local rendering* from the *debounced FTS IPC* inside `PaletteBody`
(`src/components/common/CommandPalette.tsx`) — the IPC stays debounced at
`PALETTE_DEBOUNCE_MS`; only rendering goes live:

- `groups` now ranks `mergeAndRankGroups(pages, blocks, liveQuery)` (live trimmed query,
  or `linkQuery` in link mode) instead of the debounced `effectiveQuery`, so
  already-loaded rows re-rank per keystroke; the FTS `.then` still supersedes them via
  `setPages`/`setBlocks`.
- Recents stay visible as a live-prefix filter during the debounce+IPC window:
  `showRecents`/`showRecentSearches` gate relaxed from `query.length === 0` to
  `query.length === 0 || (loading && groups.length === 0)`, with a `!linkMode` guard and
  a `filteredRecents` prefix filter; recents turn off once real `groups` exist.
- Mobile `SearchSheet.tsx` embeds the same `PaletteBody` — inherits the fix, no change.
- Tests: new block in `src/components/common/__tests__/CommandPalette.test.tsx` proving
  (a) re-rank without a new IPC call and (b) recents visible/filtered during loading then
  replaced by FTS groups, plus `axe`.

## Review

Three independent `sonnet` reviewers (one per issue, none reviewing their own build).
All three APPROVED:
- **#2851** — all 5 claims verified (motion-pattern parity, hook mapping, context-free
  `useSyncExternalStore` provider wiring so `AppRoot` needs no provider, AppearanceTab
  binding, non-vacuous tests). No changes.
- **#2852** — all 4 checks verified (only genuine full-view spinners converted, dead
  `Spinner` imports removed while `PairingEntryForm`'s is correctly kept for the inline
  Pair-button, `AdvancedQueryView` refetch path untouched, a11y i18n keys all resolve,
  tests assert skeleton-present/spinner-absent). No changes.
- **#2853** — all 5 checks verified (IPC stays debounced; live re-rank only reorders
  already-loaded rows and FTS still supersedes; recents gate turns off once real groups
  exist, `!linkMode` guard correct; no simultaneous-render regressions; tests non-vacuous
  and prove no per-keystroke IPC). One doc-comment corrected ("prefix" → "substring" to
  match the actual `.includes()` filter); no functional change.

## Result

Frontend-only, additive. No schema/store/op-type/sync changes. Targeted suites green per
item; full frontend gate run once on the settled tree before commit.

Closes #2851.
Closes #2852.
Closes #2853.
