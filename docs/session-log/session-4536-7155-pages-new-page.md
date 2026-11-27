# Session 4536 — #7155 R3 and R20: New page ends the Pages search row

Round 2 of the UI review (#7155). The maintainer rejected #7040 S3's placement of Pages' "New page" alone on the title row (decision D1 A).

**What shipped**

- **Desktop (R3).** `PageBrowserHeader` gives `FeaturePageHeader` only the title. `newPageButton` always renders last in the search row (it used to render there only on a phone), so the row reads search, count, sort, Saved views, New page.
  - At the 1024 px narrow desktop (#7040 C2) the search field shrinks and nothing wraps.
  - The empty state's "Create your first page" is unchanged.
- **Phone (R20).** The header's "+" is `outline` beside the capture button instead of `ghost`, the same size as the sort button. The ⋮ stays a ghost menu button.

**Tests**

- `PageBrowserHeader.test.tsx`: the title row holds the title alone, and New page is the search row's fourth control.
  - Two old cases pinned the S3 placement and were edited.
  - Red with New page back on the title row.
- `narrow-desktop.spec.ts`: at 1024 px the five controls share a centre line, run left to right, and search keeps at least 12rem.
  - Red on the centre line with the old placement.
- `phone-view-headers.spec.ts`: the "+" has a 1 px border, a fill, and the sort button's size, and keeps its 44 px target.
  - This replaced the ghost assertion. Red with `ghost` back.
- `view-shell.spec.ts` "a view's actions sit on its title row": checks Trash's Restore all now that Pages has no title-row action.
  - The contract under test is the `FeaturePageHeader` actions slot, not Pages.
  - Red with the title row made a column.
- A separate session reviewed the branch: no defects. It re-ran every red and the Pages, phone, narrow and view-shell e2e specs (150 passed), and screenshotted 1440, 1024 and Pixel 7 in both themes.
- Two of its notes are left for the batched follow-up: the phone "+" glyph draws smaller than sort's arrows, and `view-shell.spec.ts` now depends on Trash without a tag that selects it.
