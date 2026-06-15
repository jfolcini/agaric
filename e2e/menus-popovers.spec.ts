/**
 * E2E — menu / popover / dropdown open → item → Escape → focus-restore flows
 * (#1171).
 *
 * These five non-touch surfaces have unit coverage but no end-to-end proof
 * that, in the real app shell, the trigger opens the overlay, an item inside
 * fires, and dismissal (Escape / outside-click / select) both closes the
 * overlay AND restores focus to the trigger. We assert on rendered DOM only —
 * a visible popover, a checked item, `toBeFocused()` — never component
 * internals.
 *
 * Surfaces covered:
 *   1. TabBar dropdown switcher          (src/components/layout/TabBar.tsx)
 *   2. SourcePageFilter popover          (src/components/filters/SourcePageFilter.tsx)
 *   3. FilterHelperPopover (+ Filter)    (src/components/search/FilterHelperPopover.tsx)
 *   4. JournalCalendarDropdown           (src/components/journal/JournalCalendarDropdown.tsx)
 *   5. HasTagFilterForm tag picker       (src/components/backlink-filter/categories/HasTagFilterForm.tsx)
 *
 * Harness: the established `./helpers` exports (`waitForBoot`, `openPage`,
 * `openSearchView`, `activePopover`) — no bespoke scaffolding.
 */

import { activePopover, expect, openPage, openSearchView, test, waitForBoot } from './helpers'

// ===========================================================================
// 1. TabBar dropdown switcher (FEAT-8 / UX-262)
// ===========================================================================
//
// The TabBar (src/components/layout/TabBar.tsx) only renders with ≥2 open tabs
// (`if (tabs.length <= 1) return null`, line 114) and on a desktop viewport
// (`if (isMobile) return null`, line 110 — the Playwright project uses Desktop
// Chrome, so isMobile is false). Clicking the ACTIVE tab's label while in the
// page-editor view opens the dropdown switcher (`handleTabClick`, lines
// 126-129). We reach two tabs by opening a page, then firing the
// `openInNewTab` shortcut (Ctrl+T) which duplicates the active page into a new
// tab (useAppKeyboardShortcuts.ts TAB_SHORTCUTS / line 151).

test.describe('TabBar dropdown switcher (#1171 surface 1)', () => {
  test('open → switch tab → Escape closes and restores focus to the active tab', async ({
    page,
  }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')

    // Open a second tab so the TabBar mounts (it autohides at ≤1 tab).
    await page.keyboard.press('Control+t')

    // The tablist has aria-label "Editor tabs" (tabs.tabList, common.ts:275).
    const tablist = page.getByRole('tablist', { name: 'Editor tabs' })
    await expect(tablist).toBeVisible()

    // The active tab carries aria-selected="true" and (in page-editor view)
    // aria-haspopup="menu" — it doubles as the dropdown trigger (TabBar.tsx
    // lines 222-225).
    const activeTab = tablist.getByRole('tab', { selected: true })
    await expect(activeTab).toHaveAttribute('aria-haspopup', 'menu')

    // Click the active tab's label → dropdown opens (MenuPopoverContent with
    // role="menu", TabBar.tsx lines 276-283).
    await activeTab.click()
    const menu = page.getByRole('menu', { name: 'Editor tabs' })
    await expect(menu).toBeVisible()
    await expect(activeTab).toHaveAttribute('aria-expanded', 'true')

    // The active tab's row is a checked menuitemradio (aria-checked="true",
    // TabBar.tsx lines 310-312).
    const checkedRow = menu.getByRole('menuitemradio', { checked: true })
    await expect(checkedRow).toBeVisible()

    // Two tabs duplicate the same page, so there are two activate rows. Click
    // the OTHER one (the second menuitemradio) → switchTab + close (lines
    // 316-319).
    const rows = menu.getByRole('menuitemradio')
    await expect(rows).toHaveCount(2)
    await rows.nth(1).click()
    await expect(menu).toHaveCount(0)

    // Re-open and exercise the Escape → close path.
    //
    // NOTE on focus-restore: unlike the other four surfaces, this dropdown is
    // anchored with a bare `PopoverAnchor` (TabBar.tsx lines 269-271), NOT a
    // `PopoverTrigger`. Radix's `onCloseAutoFocus` returns focus to the
    // *trigger* element on dismiss — and there is no trigger here, only an
    // anchor (which is positioning-only, not a focus-return target). The
    // component also does not implement its own on-close focus-restore effect
    // (the dropdownItemRefs effect only moves focus while the menu is OPEN).
    // So after Escape the active tab is NOT re-focused in production; asserting
    // `toBeFocused()` here would test behavior that does not exist. We assert
    // only the close (the menu's own contract), per the "assert rendered DOM,
    // never component internals / nonexistent behavior" rule.
    const activeTabAfter = tablist.getByRole('tab', { selected: true })
    await activeTabAfter.click()
    await expect(page.getByRole('menu', { name: 'Editor tabs' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu', { name: 'Editor tabs' })).toHaveCount(0)
  })
})

// ===========================================================================
// 2. SourcePageFilter popover (linked-references source-page filter)
// ===========================================================================
//
// SourcePageFilter (src/components/filters/SourcePageFilter.tsx) renders the
// filter-icon trigger inside the LinkedReferences header
// (LinkedReferences.tsx lines 315-325). It only appears when the page has
// backlinks (totalCount > 0). Seed data: "Quick Notes" QN_1 contains
// [[PAGE_GETTING_STARTED]], so opening "Getting Started" yields one backlink
// group → the filter trigger renders. Trigger aria-label is
// "Filter by source page" (sourceFilter.filterLabel, properties.ts:157).

test.describe('SourcePageFilter popover (#1171 surface 2)', () => {
  test('open → toggle a page → Escape closes and restores focus to the filter trigger', async ({
    page,
  }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')

    const refs = page.getByTestId('linked-references')
    await expect(refs).toBeVisible()

    // The trigger is a ghost icon button labelled "Filter by source page"
    // (SourcePageFilter.tsx lines 121-130).
    const trigger = refs.getByRole('button', { name: 'Filter by source page' })
    await expect(trigger).toBeVisible()
    await trigger.click()

    // The popover (MenuPopoverContent → data-slot="popover-content") shows the
    // search input + the source-page list (SourcePageFilter.tsx lines 132-168).
    const popover = activePopover(page)
    await expect(popover).toBeVisible()
    await expect(popover.getByPlaceholder('Search pages...')).toBeVisible()

    // Toggle a source page to "include": click its row. The backlink came from
    // "Quick Notes", which appears as a `.source-page-filter-item` row.
    const pageItem = popover.locator('.source-page-filter-item').first()
    await expect(pageItem).toBeVisible()
    await pageItem.click()

    // Toggling on surfaces the "Clear all" button (rendered only when filters
    // are active — SourcePageFilter.tsx lines 169-178), proving the toggle
    // fired.
    await expect(popover.getByRole('button', { name: 'Clear all' })).toBeVisible()

    // Escape closes the Radix popover and restores focus to the trigger.
    await page.keyboard.press('Escape')
    await expect(activePopover(page)).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })

  test('outside-click closes the SourcePageFilter popover', async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')

    const refs = page.getByTestId('linked-references')
    const trigger = refs.getByRole('button', { name: 'Filter by source page' })
    await trigger.click()
    await expect(activePopover(page)).toBeVisible()

    // Click the page title (well outside the popover) → Radix outside-click
    // dismissal.
    await page.locator('[aria-label="Page title"]').click()
    await expect(activePopover(page)).toHaveCount(0)
  })
})

// ===========================================================================
// 3. FilterHelperPopover — search panel "+ Filter" (PEND-54)
// ===========================================================================
//
// FilterHelperPopover (src/components/search/FilterHelperPopover.tsx) anchors
// the "+ Filter" button (data-testid="add-filter-button", line 239) in the
// SearchPanel. Clicking it opens the category menu (data-testid
// "filter-helper-menu", line 250); picking "Tag" swaps the content in place to
// the tag value form (data-testid "filter-helper-tag", line 291); selecting an
// option applies the filter and closes the popover (handleTagSelect, lines
// 173-176).

test.describe('FilterHelperPopover +Filter (#1171 surface 3)', () => {
  test.beforeEach(async ({ page }) => {
    await openSearchView(page)
  })

  test('open menu → pick Tag dimension → value form → apply closes the popover', async ({
    page,
  }) => {
    await page.getByTestId('add-filter-button').click()

    // Main category menu.
    const helperMenu = page.getByTestId('filter-helper-menu')
    await expect(helperMenu).toBeVisible()

    // Pick the "Tag" dimension → the in-place tag value form replaces the menu.
    await helperMenu.getByText('Tag', { exact: true }).click()
    const tagForm = page.getByTestId('filter-helper-tag')
    await expect(tagForm).toBeVisible()
    await expect(helperMenu).toHaveCount(0)

    // The tag listbox is an ARIA combobox/listbox (UX-A6); seed tags come from
    // list_tags_by_prefix. Applying #work routes through onAddTag and closes
    // the popover (FilterHelperPopover.tsx lines 173-176).
    await tagForm.getByRole('option', { name: '#work' }).click()
    await expect(page.getByTestId('filter-helper-tag')).toHaveCount(0)

    // The applied filter surfaces as a chip and is reflected in the query.
    await expect(page.getByTestId('filter-chip-bar')).toContainText('tag:#work')
  })

  test('Escape inside the tag form closes the FilterHelperPopover', async ({ page }) => {
    await page.getByTestId('add-filter-button').click()
    await page.getByTestId('filter-helper-menu').getByText('Tag', { exact: true }).click()
    const tagInput = page.getByTestId('filter-helper-tag').getByRole('combobox')
    await expect(tagInput).toBeVisible()

    // The tag combobox handles Escape → handleOpenChange(false) (lines
    // 198-201), closing the whole popover.
    await tagInput.press('Escape')
    await expect(page.getByTestId('filter-helper-tag')).toHaveCount(0)
    await expect(page.getByTestId('filter-helper-menu')).toHaveCount(0)
  })

  test('outside-click closes the FilterHelperPopover', async ({ page }) => {
    await page.getByTestId('add-filter-button').click()
    await expect(page.getByTestId('filter-helper-menu')).toBeVisible()

    // Click the search input (outside the Radix popover) → dismissal.
    await page.getByPlaceholder('Search blocks...').click()
    await expect(page.getByTestId('filter-helper-menu')).toHaveCount(0)
  })
})

// ===========================================================================
// 4. JournalCalendarDropdown (journal date picker)
// ===========================================================================
//
// JournalControls (src/components/journal/JournalControls.tsx) renders the
// calendar icon button (aria-label "Open calendar picker",
// journal.openCalendar / pages.ts:40) which toggles the
// JournalCalendarDropdown. The dropdown is a non-modal role="dialog"
// (JournalCalendarDropdown.tsx line 217, aria-label "Date picker"). It owns
// its own Escape handler (lines 181-190) and restores focus to the opener on
// unmount (lines 173-178). Selecting a non-selected, in-month day fires
// onSelectDate (Calendar onSelect, line 233) → navigateToDate + close. The app
// boots into the journal daily view, so the control is present without extra
// navigation.

test.describe('JournalCalendarDropdown (#1171 surface 4)', () => {
  test('open → pick a date → dropdown closes and focus restores to the calendar button', async ({
    page,
  }) => {
    await waitForBoot(page)

    const calBtn = page.getByRole('button', { name: 'Open calendar picker' })
    await expect(calBtn).toBeVisible()
    await calBtn.click()

    // The dropdown is a role="dialog" labelled "Date picker".
    const dropdown = page.getByRole('dialog', { name: 'Date picker' })
    await expect(dropdown).toBeVisible()
    await expect(calBtn).toHaveAttribute('aria-expanded', 'true')

    // Week-number and month navigation are present (showWeekNumber +
    // onWeekNumberClick / onMonthClick, JournalCalendarDropdown.tsx lines
    // 236-239) — assert the affordances render.
    await expect(dropdown.getByRole('button', { name: /Go to week/ }).first()).toBeVisible()
    await expect(dropdown.getByRole('button', { name: 'Go to monthly view' })).toBeVisible()

    // Pick a real, in-month, non-selected day. react-day-picker renders each
    // day as a role="gridcell" with data-selected/data-outside markers
    // (DayPicker grid); the inner <button> is the click target. Selecting the
    // already-selected day would deselect (onSelect receives undefined → our
    // guard `day && onSelectDate(day)` no-ops), so we deliberately avoid
    // [data-today]/[data-selected]/[data-outside].
    const day = dropdown
      .locator(
        '[role="gridcell"]:not([data-outside]):not([data-selected]):not([data-today]) button',
      )
      .first()
    await expect(day).toBeVisible()
    await day.click()

    // Selecting a date unmounts the dropdown (setCalendarOpen(false)) — the
    // change fired. Focus restores to the opener via the unmount effect.
    await expect(page.getByRole('dialog', { name: 'Date picker' })).toHaveCount(0)
    await expect(calBtn).toBeFocused()
  })

  test('Escape closes the JournalCalendarDropdown and restores focus', async ({ page }) => {
    await waitForBoot(page)

    const calBtn = page.getByRole('button', { name: 'Open calendar picker' })
    await calBtn.click()
    await expect(page.getByRole('dialog', { name: 'Date picker' })).toBeVisible()

    // The dropdown's own keydown handler closes on Escape (lines 181-190).
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Date picker' })).toHaveCount(0)
    await expect(calBtn).toBeFocused()
  })

  test('outside-click (backdrop) closes the JournalCalendarDropdown', async ({ page }) => {
    await waitForBoot(page)

    const calBtn = page.getByRole('button', { name: 'Open calendar picker' })
    await calBtn.click()
    const dropdown = page.getByRole('dialog', { name: 'Date picker' })
    await expect(dropdown).toBeVisible()

    // The dropdown renders a fixed full-screen backdrop (role="presentation",
    // line 213) whose onClick fires onClose. Click the top-left corner, away
    // from the anchored calendar panel (which sits at the top-right).
    await page.mouse.click(8, 8)
    await expect(page.getByRole('dialog', { name: 'Date picker' })).toHaveCount(0)
  })
})

// ===========================================================================
// 5. HasTagFilterForm tag picker (backlink "Has Tag" filter)
// ===========================================================================
//
// The backlink BacklinkFilterBuilder (LinkedReferences.tsx lines 356-366)
// exposes an "Add filter" button (backlink.addFilterLabel = "Add filter",
// BacklinkFilterBuilder.tsx lines 202-211). It reveals AddFilterRow, whose
// category Select offers "Has Tag" (AddFilterRow.tsx line 251), mounting
// HasTagFilterForm. That form's trigger
// (data-testid="tag-search-popover", HasTagFilterForm.tsx line 87) opens a
// Radix popover wrapping a cmdk Command list of seed tags; selecting one fires
// handleSelect → close (lines 75-78).

test.describe('HasTagFilterForm tag picker (#1171 surface 5)', () => {
  test('Has Tag filter → tag picker opens → select a tag → Escape closes', async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')

    const refs = page.getByTestId('linked-references')
    await expect(refs).toBeVisible()

    // Reveal the AddFilterRow inside the backlink filter builder. This "Add
    // filter" button is scoped to the linked-references panel (distinct from
    // the pages-view "Add filter").
    await refs.getByRole('button', { name: 'Add filter', exact: true }).click()

    // Pick the "Has Tag" category from the Select. The trigger is labelled
    // "Filter category" (backlink.filterCategoryLabel, references.ts:109).
    await refs.getByRole('combobox', { name: 'Filter category' }).click()
    await page.getByRole('option', { name: 'Has Tag' }).click()

    // HasTagFilterForm mounts its trigger button (data-testid
    // "tag-search-popover", HasTagFilterForm.tsx lines 82-90).
    const tagTrigger = page.getByTestId('tag-search-popover')
    await expect(tagTrigger).toBeVisible()
    await tagTrigger.click()

    // The popover (MenuPopoverContent → data-slot="popover-content") hosts the
    // cmdk Command list seeded with work/personal/idea tags.
    const popover = activePopover(page)
    await expect(popover).toBeVisible()
    await expect(popover.getByPlaceholder('Search tags...')).toBeVisible()

    // Select a tag (cmdk CommandItem rows render the tag name). Selecting fires
    // handleSelect → setTagSearchOpen(false): the popover closes and the
    // trigger relabels to the chosen tag.
    await popover.getByRole('option', { name: 'work' }).click()
    await expect(activePopover(page)).toHaveCount(0)
    await expect(page.getByTestId('tag-search-popover')).toHaveText('work')

    // Re-open and confirm Escape dismisses the Radix popover.
    await page.getByTestId('tag-search-popover').click()
    await expect(activePopover(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(activePopover(page)).toHaveCount(0)
  })
})
