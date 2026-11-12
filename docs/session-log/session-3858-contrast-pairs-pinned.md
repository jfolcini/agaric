# Session 3858 — Contrast pairs pinned, failing tokens corrected (#6528)

Took the first four checkboxes of #6528: the DONE check mark in the dark themes, the sidebar Sync
button's dot and error state, form-field outlines under "more contrast", and turning
`src/lib/__tests__/theme-contrast.test.ts` from a hand-picked list into a generated one.

**What changed.** The contrast test now measures every `--x-foreground` on its `--x` in six themes
and both contrast modes (names read from the theme blocks; a pair already pinned in `THEME_PAIRS`
or `CROSS_PAIRS` is not measured twice), plus hand rows for the cross pairs no naming rule reaches:
`primary` and `destructive` as text, `star` and `task-custom` as indicators, and the new
`--highlight-foreground` on `--highlight`. `THEME_PAIRS` gained the DONE glyph and the idle / syncing
dots on `--sidebar`; a new block pins `--input` on `--background` under more contrast. Every case
already in the file is still there at its old threshold (375 names before, all present after).

The tokens those cases turned red were moved by the smallest lightness step that clears the
threshold, hue and chroma kept: the DONE glyph is dark in `.dark` (inherited by all four dark
themes), `--input` gets a mid grey beside `--border` in the `prefers-contrast: more` `*` rule,
the light themes' sync dots, star, custom-state dot and two op chips are darker, Solarized Light's
primary is darker, the alternate dark themes' destructive red and One Dark Pro's purple chip inks
are lighter, and Dark / Solarized Dark lift `--highlight` so black text (the browser's old `<mark>`
colour, now the token) clears 4.5:1. `.ProseMirror mark`, the view-mode mark and `HighlightMatch`'s
mark all paint `text-highlight-foreground`. Under more contrast, `Input` and `Textarea` drop their
dark `bg-input/30` fill: 30% of the new grey put their placeholder at 3.9 to 4.4:1 in the alternate
dark themes (measured in Chromium), 5.9:1 or more without it.

The Sync button now swaps its glyph to an alert on a standing error and puts the stored error first
in its tooltip and its accessible description; offline still wins. `e2e/sync-happy-paths.spec.ts`
asserts the error's tooltip line and description; the two toast assertions in
`e2e/sync-events.spec.ts` are scoped to the toast, because the button's description now carries the
same sentence.

**Traps.** The test's high-contrast reader only looked at `:root` / `.dark` rules, so the `*` rule
that sets `--border` (and now `--input`) was invisible to it; `cascade()` now reads that rule first,
which is what the browser does for every element below the root. A single `--input` value works
for all themes only because L 0.62 sits between the light pages and the darkest dark popovers;
L 0.7 (the border's value) is 2.6:1 on the light page.

**Not done.** The no-peers half of checkbox 2 (a solid dot, a "No devices paired" line, a distinct
description) needs three existing tests edited: `App.test.tsx` pins the dot to the class
`bg-status-pending`, and two `AppSidebar.test.tsx` cases pin the no-peers description to exactly
"Never synced". Left for a maintainer decision.

**Checks run.** `npx vitest run` on the contrast, AppSidebar, App, RichContentRenderer, text-mark
and HighlightMatch files (1033 passed); every new case shown red on main's tokens and again by a
trap-guarded mutation; `npm run typecheck`; oxlint and oxfmt on the changed files; a Tailwind
compile of `index.css` confirming the new utility. Review: the old case set extracted from both
versions of the contrast test (375 and 742 cases; none dropped, none loosened); five changed ratios
recomputed by an independent route; screenshots in the six themes; `sync-happy-paths`,
`sync-events`, `sync-last-synced`, `bubble-marks` and `code-comment-contrast` specs (25 passed), the
new error assertions shown red with the error label disabled.
