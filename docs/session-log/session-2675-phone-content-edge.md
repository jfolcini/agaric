# Session 2675 — on a phone, headings, block text, sheets and settings cards share one 16 px edge

#5929, measured at 390 × 844 with touch: block text started at 32, settings
card text at 41, sheet text at 24 from the sheet's edge, and the journal's
Today card at 4. The drawer item and the search sheet's nested box went with
#5948 and #5931.

- **`Card`** gets two CVA variants: the default `section` drops its border,
  fill, shadow, rounding and side padding below `sm`, since every card but one
  only groups settings; `PairingPeersList` uses `item` and keeps its box. App
  health's metric tiles keep theirs: no longer nested on a phone, their border
  carries the queue-warning colour.
- **`Sheet`** pads `p-4 sm:p-6`, with the close button and `SheetBody` margins
  to match; the mobile sidebar and the journal calendar sheet set their own
  padding so the larger value doesn't return between 640 and 767 px.
- **Blocks:** on touch the block tree shifts left 16 px so block text lines up
  with the title, as desktop's `md:pointer-fine:-ml-13.5` does; Add block's
  icon shifts with it.
- **Today card** runs to the screen edge below `md` (`-mx-4 px-4`); from `md`
  up it is as before.

After: headings, block text, sheet contents and settings card contents at 16;
task text at 60 (16 plus the 44 px checkbox). Desktop screenshots of Journal,
Settings and App health are byte-identical before and after.

`e2e/phone-content-edge.spec.ts` (4 tests) checks those edges on Journal, a
page, the outline sheet and Settings; restoring the sources failed all four,
and reverting `DaySection` or `AddBlockButton` alone failed their own checks.
`mobile-drawer.spec.ts` starts its edge swipe beside the day heading, since
block rows now reach x = 0.

Ran: the whole Playwright lane in four shards (1321), vitest over the changed
components (1536), `npm run typecheck`, `oxlint src e2e`.
