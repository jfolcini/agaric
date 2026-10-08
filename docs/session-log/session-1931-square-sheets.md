# Session 1931 — square corners on every Sheet (#5367)

The user noticed the bottom search sheet still had rounded top corners after
#5232 squared the mobile nav drawer. That fix was local: the drawer passed
`rounded-none` to fight the primitive, while `src/components/ui/sheet.tsx`
kept a rounded inward edge on all four sides.

What shipped:

- The Sheet primitive drops the per-side `rounded-*-xl` classes, so every
  drawer and side panel is square. Dialogs and popovers keep their radius.
- The mobile nav drawer's `rounded-none` override and its comment are gone
  (`src/components/ui/sidebar.tsx`); no other `SheetContent` caller passed a
  radius.
- `sheet.test.tsx` asserts no side variant carries a `rounded` class, one case
  per side. `e2e/mobile-overflow.spec.ts` still checks the drawer's corners
  are `0px`, now true through the primitive.

The issue was filed together with #5353 (the Android keyboard covering the
search sheet). That one turned out to be native: `MainActivity.kt` swallows
the keyboard inset before the WebView sees it, so it moved to its own branch
pending a device check.

Verified: the new test went red with `rounded-r-xl` put back on the left
variant only (reviewer, on a copy, restored and `cmp`-checked);
`npx vitest run` on the sheet, sidebar and SearchSheet tests, 115 passed;
`npm run typecheck` clean; oxlint and oxfmt clean on the changed files.
Playwright and the full suite run in CI.
