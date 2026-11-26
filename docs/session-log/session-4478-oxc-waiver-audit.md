# Session 4478 — every oxc waiver is necessary and says why

The maintainer asked whether the repo's oxc waivers are necessary and well justified. The commit hook already fails a directive that suppresses nothing (`oxlint --type-aware --report-unused-disable-directives-severity=error`). So the audit asked, of each of the 451 inline directives and the config-level ones, whether a small, behaviour-preserving change satisfies the rule, and whether the reason is true.

**Removed: the code now satisfies the rule.**
- `role="dialog"` on Radix Popover and Dialog content (AddFilterPopover, CommandPalette). Radix renders it.
- `role="group"` divs became `<fieldset>`, keeping their `aria-label`: FilterGroup, the AgendaFilterBuilder dimension picker, HighlightColorPicker, FilterSortControls, FilterChipRow, SpacesTab and SpaceAccentPicker. Tailwind's preflight resets the fieldset's border, margin and padding. `min-w-0` replaces its `min-inline-size: min-content` where it sits in a flex column.
- `role="status"` spans became `<output>`: InPageReplaceRow, and a ListViewState test fixture.
- The 11 non-null assertions in three test files became getters that throw.
- `usePropertySave` destructures `toasts` in its parameters.
- Four `exhaustive-deps` waivers: stable refs and setters listed, or `useEffectEvent` in `usePageBrowserAutoLoad` and `SelectedItemBridge`.
- The file-level disable on the generated emoji data, which `ignorePatterns` already covers.
- In `.oxlintrc.json`, `no-console` is raised to error, and `src/main.tsx` leaves the `no-default-export` override.

**Rewritten.** 47 reasons were missing, vague, false or out of date. Two complexity waivers claimed "26, one point over 25"; the functions score 59 and 52. Seven `incompatible-library` reasons cited react-virtual versions long gone. Several said a `<fieldset>` would break the layout, which it does not. Block-level directives became per-line ones; one in MonthlyView.test had no closing directive and covered the rest of the file.

**Found in review.**
- The babel React Compiler skips a function only for `eslint-disable-next-line react-hooks/…`, not the `oxlint-` spelling. Respelling QueryResult's directive would have switched the compiler on for an untested component. That directive is restored, with a comment saying the spelling matters, and `.oxlintrc.json` no longer claims either spelling works.
- `usePropertySave`'s two custom-toast-key tests could not fail: the custom key rendered the default's text. They now use keys whose text differs.
- The "oxlint 1.79" version figures in `.oxlintrc.json` and the suppression test's docblock are gone.

**Left alone, deliberately.**
- `PaletteBody` and `DaySectionInner` (complexity 59 and 52) need the orchestrator split that docs/UX.md describes.
- In App, PageRow and GraphFilterBar, removing an `exhaustive-deps` waiver would switch the compiler on for a large component. That needs a compile check and the mobile e2e for each.
- The 12 `set-state-in-effect` waivers #4407 decided on.

**Ran.**
- `oxlint --type-aware --report-unused-disable-directives-severity=error .`: 0 errors. `oxfmt --check` on the changed files, and `npm run typecheck`.
- vitest over every changed test and every test that renders or calls a changed source: 112 files, 3297 passed.
- Eleven mock-lane Playwright specs whose areas the change touches: 75 passed.
- Compiling QueryResult and SelectedItemBridge with the compiler plugin and a logger, before and after.
- Chromium screenshots of FilterChipRow, FilterGroup, the spaces panel and the highlight picker. Div and fieldset layouts compared for all eight fieldsets: pixel-identical, once HighlightColorPicker took `min-w-0`.

**Not covered by a test.** These need a compile check or the e2e build to see:
- `usePageBrowserAutoLoad`'s pixel trigger. Its `useEffectEvent` rewrite was shown equivalent by reading the code: PageBrowser renders synchronously.
- `SelectedItemBridge`'s re-sync when the highlight moves.
- QueryResult's compiler skip.
