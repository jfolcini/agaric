# Session 4554 — follow-up sweep: review notes on the PRs merged 2026-11-27

One follow-up for every non-blocking review note left on today's merged PRs (#7154, #7157–#7164, #7166–#7175), and a flake survey. #7163 batched round 2's notes (session 4543) and #7174 round 3's (session 4552); this sweep checks each disposition against main and picks up the rest.

**Where the notes came from**

The agaric-reviewer bot's review bodies, inline comments, bot issue comments, and the "claude-review findings" check run on each PR's head. Inline comments: none. Bot issue comments: only the mutation, file-overlap and CI notices. #7154, #7168 and #7172 had no review. The #7175 review session's notes came by message from the orchestrator. #7159, #7161, #7163, #7164, #7169, #7170 and #7174 had approvals with no notes.

**Findings**

| PR | Finding | Disposition |
| --- | --- | --- |
| #7157 | `SortableBlock`'s comment says the phone frame shift is top-level only; it applies at every depth | (a) #7163 (`ddefca5`): the comment above `isTouchDevice && isPhone && 'ml-2 …'` says every depth |
| #7158 | High-contrast `:focus-visible` outline in `@layer base` loses to `outline-hidden`/`outline-none`: the attachment caption input has no focus cue | (a) the caption input carries `focus-ring-visible` and no `outline-none` on main; `AttachmentRenderer.test.tsx` "rings the caption input on keyboard focus" pins it |
| #7158 | Same, for the breadcrumb text crumb | (b) the crumb's focus cue is `focus-visible:underline`, a deliberate, documented deviation in `breadcrumb.tsx`; it still shows in high-contrast mode |
| #7159 | Had no bot note; session 4543 took its review-session note (`AtomicU64` import) | (a) #7163 |
| #7160 | `kbd.tsx`: `cn(kbdVariants(…))` with one argument does nothing | (c) plain `kbdVariants({ size, tone })` |
| #7162 | `QueryResultList.test.tsx` cites the deleted `AlertSection.test.tsx` | (a) gone on main; #7162's final head (`d362f40`) removed it |
| #7162 | Under Group: Page, `flatItems` stays in date order while rows draw in grouped order | (a) #7163: `DuePanel.tsx` builds `flatItems` from `groups.flatMap((g) => g.rows)`, the drawn order |
| #7166 | `LocalGraphControl` inside the filter bar's error boundary | (a) #7174, session 4552 |
| #7166 | `GraphFilterBar` always passes `trailing` | (a) #7174, session 4552 |
| #7167 | Phone nested chevron offset uses `--block-gap`, not the phone gap | (a) #7174: premise false (both 0.25rem); the test now pins the chevron to the first glyph |
| #7173 | `offGrey` repeats `tokenColor`'s probe | (a) #7174 (`resolvedColor`) |
| #7173 | `switch.test.tsx` header has two blank lines | (a) #7174 |
| #7174 | `expectTrailingAtEnd` checks y loosely | (b) the Graph control sits at the end of the actions row on the desktop and on its own row on a phone, so an exact check is per profile, not one line; the reviewer asked for nothing |
| #7171 | `self_update_disabled` checks any `SNAP`, which a copy started from another snap (a terminal in the VS Code snap) inherits, so an AppImage or `.deb` loses its updater | (c) `is_agaric_snap` reads `SNAP_NAME == "agaric"` (the name in `packaging/snap/snapcraft.yaml`); `self_update_tests` "a copy started from another snap keeps self update" red with any `SNAP_NAME` accepted. `docs/BUILD.md` says the same |
| #7171 | `useSelfUpdateDisabled` is `undefined` until the IPC answers, so a package-managed copy flashes Help's Check button and status | (c) `HelpTab` shows them only once the answer is `false`; `HelpTab.test.tsx` "shows no check button or status until it knows…" red with `!selfUpdateDisabled` |
| #7175 review | `SourcePageFilter`'s docstring calls include green; `text-primary` is ink | (c) it names the `primary` and `destructive` tokens |
| #7175 review | No spec pins that the references' 44 px rows on a phone do not overlap | (c) `filter-bar-layout.spec.ts` "References: each control takes the taps on its own face" hit-tests the centre and 2 px inside each edge of the header, the kind radios, Add filter, Source pages, the Sort picker and its direction button, on both profiles. The rows passed as they are; red with the kind toggle pulled 8 px up (`coarse:-mt-2`), on the header's bottom edge |
| #7175 review | The Sort direction button's 44 px hit area overlaps the Sort picker by 5 px (predates #7175) | (c) real: a tap 2 px inside the picker's end toggled the direction (the spec above, red at `351,533` on a Pixel 7). The button was 36 px wide with a centred 44 px area, joined by `-ml-px`. It is now `coarse:w-11`, so the area is its own box: still 44 × 44 as `phone-touch-targets.spec.ts` and `page-editor-polish.spec.ts` pin (narrowing the area to the button's width instead failed both), and red again without the class |
| #7175 | The translator comment above `sourceFilter.filterLabel` calls the trigger a "filter icon button" | (c) it now names the "Source pages" button and says the string titles the phone sheet, which is its only use; the other locales carry no translator comments |

**Flakes**

- None since session 4552's survey (from 04:00Z): 221 runs, the 1368 jobs of the 81 CI, e2e-tauri and Mutation runs among them, every attempt. No run reached a second attempt, and no head SHA has both a failing and a passing run.
- Failures, none a flake: `advanced-query-group.spec.ts` on the bridge on main at `ddefca5` (session 4552, fixed by `a3bdd95`); `playwright install-deps` refused by `packages.microsoft.com` (403, "no longer signed") on main at `3e34006` and twice on #7171, runner infrastructure; the two stale e2e-tauri smoke specs on #7171 (`settings-desktop-integration`, `sync-two-device` Overdue), fixed by #7174 and green on #7171 from `af56625b`.
- The e2e-tauri nightly on main at `d2fed8f` passed, and so did the last scheduled deep checks (11-26, `42bf319`).

**Tests**

- Each behaviour fix above was shown red by breaking the code it covers; the comment and class-string cleanups have no test.
- No old assertion edited.
- `npm run typecheck`, `npm run lint`, and the related vitest files (the first commit's range touched `kbd.tsx` and an i18n file, so it ran all 1151 files: 27503 passed; this commit's 10 files: 280 passed; `HelpTab`, `useUpdateCheck`, `SettingsView`: 169 passed).
- `cargo clippy --workspace --all-targets -- -D warnings` clean; `self_update_tests` 6 of 6.
- `e2e-related` picks the whole lane (`kbd.tsx` has no area), which is CI's run. Run locally: `filter-bar-layout`, `phone-touch-targets`, `page-editor-polish`, `references-filters`, `references-add-filter-click`, `menus-popovers`, `view-shell`.
