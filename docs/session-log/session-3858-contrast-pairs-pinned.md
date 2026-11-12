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

**No devices paired.** The no-peers dot painted `bg-status-pending`, the soft fill half of the
chip pair (1.04 to 1.65:1 on `--sidebar`); it now paints the solid half,
`bg-status-pending-foreground`, which clears 3:1 in all twelve cells as it stands, so no token
moved. `THEME_PAIRS` pins it beside the idle / syncing dots (red on `status-pending` first). The
button's first tooltip line and an `sr-only` line ahead of "last synced" in its description say
"No devices paired" (`sync.noPeersTitle`, the dialog's title); one `SYNC_STATUS_ID` span carries
either that or the error, and no peers wins over a stale error, as it does for the dot. The alert
glyph still means an error only. `docs/features/sync.md` lists both states.

Existing assertions edited, old to new: `App.test.tsx` no-peers dot
`toHaveClass('bg-status-pending')` to `'bg-status-pending-foreground'`; its four
NoPeersDialog-absence checks `queryByText(t('sync.noPeersTitle'))` to
`queryByTestId('no-peers-dialog')`, since the title text is now also on the button.
`AppSidebar.test.tsx`: the two dot-class cases `toContain('bg-status-pending')` to
`'bg-status-pending-foreground'`; the tooltip/description case, description "Never synced" to
"No devices paired Never synced" and tooltip `syncTooltip` to `sync.noPeersTitle`; the fake-clock
case, both "Last synced …" descriptions gain the "No devices paired" prefix.
`e2e/sync-happy-paths.spec.ts` starts on the fresh install: dot class, description
"No devices paired Never synced" (read before the tooltip opens) and the tooltip lines.

**Trap.** The NoPeersDialog "does NOT open" absence check is weak on its own: the dialog is lazy, so
it passes before the chunk would mount; that test's teeth are its `syncAll` assertion. The Cancel
test's absence check was shown red with the dialog held open.

**Checks run.** `npx vitest run` on the contrast, AppSidebar, App, RichContentRenderer, text-mark
and HighlightMatch files (1033 passed); every new case shown red on main's tokens and again by a
trap-guarded mutation; `npm run typecheck`; oxlint and oxfmt on the changed files; a Tailwind
compile of `index.css` confirming the new utility. Review: the old case set extracted from both
versions of the contrast test (375 and 742 cases; none dropped, none loosened); five changed ratios
recomputed by an independent route; screenshots in the six themes; `sync-happy-paths`,
`sync-events`, `sync-last-synced`, `bubble-marks` and `code-comment-contrast` specs (25 passed), the
new error assertions shown red with the error label disabled.

No-peers pass: `npx vitest run` on the AppSidebar, App and contrast files (908 passed); the new
contrast row red in all twelve cells on `status-pending` and red in Light with
`--status-pending-foreground` raised to L 0.8; the sidebar description cases red with the label
dropped; `npm run typecheck`; oxlint and oxfmt on the changed files; `sync-happy-paths` (2 passed,
red with the label dropped), `sync-last-synced`, `sync-events` and the NoPeersDialog case of
`sync-pairing-flows` (8 passed).
