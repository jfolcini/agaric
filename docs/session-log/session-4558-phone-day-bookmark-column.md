# Session 4558 — the phone day's bookmark sits in its checkboxes' column

On a touch phone, the Day view's row above the blocks holds the day's bookmark and its ⋮ menu. Each is a 44 px button with its 20 px icon centred, so the icons sat 12 px inside the content edges: the bookmark at x 28–48 against task checkboxes at 16–34 (Pixel 7), and the ⋮ at 364–384 against the top bar's search icon ending at 396. Reported by the maintainer as the bookmark looking offset from the checkboxes.

**Fix**

The row takes `coarse:-mx-3` (`DayPageEditor`), the pattern `SearchSheetTrigger` and `CollapsibleGroupList` already use: the icon, not its button, on the content edge. The bookmark's icon now starts at 16, in the checkboxes' column, the ⋮ ends under the search icon, and both buttons keep their 44 px targets inside the 16 px gutter. A page's header is not affected: its bookmark sits right of the title.

**Test**

`journal-header-sections.spec.ts` › *journal on a phone*: the bookmark icon's left edge equals the first task checkbox's, and the ⋮ icon's right edge equals the search icon's. Red before the fix (28 vs 16); a left-only margin reddens the right-edge half (384 vs 396).

`mobile-drawer.spec.ts` started its left-edge swipe at x 5 beside the day's `<h1>`, which on a phone is a 1 px assistive-tech heading on this row, so the bookmark's button now took that point. The bookmark's button now matches the header's menu button (button 4–48, icon 16–36), and task checkboxes and block rows already reached x 5, so the spec now scans down from the header for the first gutter point no control takes.

**Ran**

`npx vitest run src/components/journal`; Playwright `journal-header-sections` and every `phone-*`, `mobile-*`, `journal-*`, `touch-*`, `android-phone` and `app-chrome` spec. `just e2e-related` selects 346 specs for `DayPageEditor`; the rest is CI's.
