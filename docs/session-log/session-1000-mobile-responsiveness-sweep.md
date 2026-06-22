# Session 1000 — mobile responsiveness sweep + sidebar collapse leak

Reported on a 2025 Google Pixel: the device-pairing dialog's "Scan QR Code" / "Type
Passphrase" toggle buttons sit side-by-side and overflow the dialog on narrow phones, and
the collapsed sidebar leaks a few pixels of menu text. Asked to fix those and sweep every
view/dialog for mobile responsiveness, with a local-only (not CI) overflow guard.

## Issues

- **#1966** — pairing toggle overflow + whole-UI responsiveness sweep (this PR).
- **#1967** — sidebar leaks menu text when collapsed on mobile (this PR).
- **#1968** — block gutter wastes horizontal space (fixed 68px lane + always-on chevron
  placeholder); agreed redesign captured for a **follow-up PR** (riskier, touches core
  editor + touch DnD).

## Shipped

- **Pairing entry-mode toggle** (`PairingEntryForm.tsx`): row is now
  `flex flex-col gap-2 sm:flex-row`, buttons `w-full sm:w-auto` — stacks on phones, sits
  inline from `sm` up. The QR button (icon + label + "Recommended" badge) no longer
  overflows at 360/390px.
- **Sidebar collapsed rail clip** (`ui/sidebar.tsx`): added `overflow-hidden` to the mobile
  icon-rail `sidebar-container` and `min-w-0 overflow-hidden` to `sidebar-inner`, so the
  fixed 48px rail hard-clips labels — no paint bleed past the edge.
- **Defensive wrap** on dialog control rows the sweep can't reach: `QueryBuilderModal`
  mode-toggle + query-type radiogroup and `PdfViewerDialog` toolbar/nav rows now
  `flex-wrap`.

## Overflow sweep (local-only)

- `e2e/helpers.ts`: `expectNoHorizontalOverflow(page, target?, label?)` — asserts
  `scrollWidth <= clientWidth` on the document or a dialog/sheet, ignoring intentional
  `overflow-x` scrollers, and reports the widest offending elements on failure.
- `e2e/mobile-overflow.spec.ts`: opens all 11 top-level views + the collapsed rail + the
  Keyboard Shortcuts and Pairing dialogs at iPhone-13 (390px) and a narrow 360px Android
  width, asserting no horizontal overflow. Gated out of CI via
  `test.skip(!!process.env['CI'], …)`. **28/28 green.**
- Regression guards visible to CI (the sweep isn't): unit assertions added for the pairing
  toggle stacking (`PairingEntryForm.test.tsx`) and the rail clip (`sidebar.test.tsx`).

## Verification

- `npx playwright test e2e/mobile-overflow.spec.ts` → 28 passed.
- No regressions: `mobile-editor`, `search-view-mobile`, `touch-menus`, `sync-ui` e2e green;
  affected vitest suites green; `tsc -b` + `oxlint` clean on changed files.
