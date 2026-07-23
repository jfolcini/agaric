# Session 1220 — Real-backend WDIO round-trip specs (#3085)

**Issue:** #3085 (part of umbrella #3082; advances #155 on the #3078 harness)

## Problem

The #3081 tag bug class — durable state vanishing after navigation — is invisible to
every mock-backed layer by construction. The only structural cure is round-trips against
the real Rust backend + real WebView.

## Fix

5 round-trip specs + shared helpers under `e2e-tauri/`, auto-discovered by the existing
`wdio.conf.ts` glob (no config/workflow changes):

- `helpers.ts` — `waitForAppReady`, `navigateTo(label)` (aria-name nav +
  `aria-current="page"` readiness), `addBlockWithMarker`, `blockStaticByMarker`.
- `tag-roundtrip.e2e.ts` — the #3081 regression spec: create tag in Tags view →
  Journal → back → tag still listed.
- `block-persist-reload.e2e.ts` — create block → Settings (full unmount via
  ViewDispatcher's single-view switch) → back → re-renders. Navigate-away proxy chosen
  over `browser.refresh()` (reload risks losing the re-injected IPC bridge under
  tauri-driver — documented in-spec).
- `reserved-property-roundtrip.e2e.ts` — task-marker null→TODO cycle → nav away/back →
  state persists (review hardened with `moveTo()` hover before the opacity-0 click).
- `journal-note-crossview.e2e.ts` — Journal create → Pages → back.
- `block-edit-persist.e2e.ts` — re-enter committed block, append text, nav round-trip.

## Verification (harness not runnable locally — no webkit driver/display)

- Verification ceiling honored: `tsc -p tsconfig.wdio.json` → zero spec errors (only the
  2 pre-existing environmental TS2688s); oxlint clean (coverage proven via a
  planted-probe check); every selector/i18n string mapped to source file:line by builder
  AND independently re-verified in adversarial review (accessible-name computation,
  aria-current propagation through the SidebarMenuButton spread, verbatim tag testid
  template, task-marker ancestor chain free of pointer-events-none, single-locale 'en'
  pinning).
- Review verdict: SHIP-WITH-FIXES (the moveTo hardening). Per-spec first-run confidence:
  2 HIGH, 2 MEDIUM-HIGH, 1 MEDIUM (block-edit-persist's re-enter/caret path is the one
  flow not proven by the existing smoke).
- Flagged watch item for the first live run: the task-marker renders only when
  `!isTouch` — if CI WebKit reported a coarse pointer the reserved-property spec would
  fail at waitForExist (desktop xvfb should report fine-pointer).
- First live validation: trigger `e2e-tauri-weekly.yml` via `workflow_dispatch` after
  merge instead of waiting for the Monday cron.
