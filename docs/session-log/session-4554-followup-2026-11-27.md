# Session 4554 — follow-up sweep: review notes on the PRs merged 2026-11-27

One follow-up for every non-blocking review note left on today's merged PRs (#7154, #7157–#7164, #7166–#7170, #7172–#7175). #7163 batched round 2's notes (session 4543) and #7174 round 3's (session 4552); this sweep checks each disposition against main and picks up the rest.

**Where the notes came from**

The agaric-reviewer bot's review bodies, inline comments, bot issue comments, and the "claude-review findings" check run on each PR's head. Inline comments: none. Bot issue comments: only the mutation, file-overlap and CI notices. #7154, #7168 and #7172 had no review. #7159, #7161, #7163, #7164, #7169, #7170 and #7174 had approvals with no notes.

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
| #7175 | The translator comment above `sourceFilter.filterLabel` calls the trigger a "filter icon button" | (c) it now names the "Source pages" button and says the string titles the phone sheet, which is its only use; the other locales carry no translator comments |

**Tests**

- Comment and class-string cleanups only; no behaviour changed, so no test.
- `npm run typecheck`, `just check-fe`.
