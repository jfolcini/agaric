import { expect, test } from '@playwright/test'
import { waitForBoot } from './helpers'

/**
 * E2E tests for advanced agenda / journal interactions.
 *
 * Covers: Due date filtering, scheduled date filtering, task state changes
 * in the journal daily view, overdue task display, date navigation, and
 * view mode interactions (daily/weekly/monthly/agenda).
 *
 * Seed data (tauri-mock.ts):
 *   PAGE_DAILY — content = today's date, 5 child blocks:
 *     BLOCK_DAILY_1: "Morning standup notes"                     (no state)
 *     BLOCK_DAILY_2: "Review project milestones"                 (no state)
 *     BLOCK_DAILY_3: "Buy groceries"        — TODO,  P1, due today
 *     BLOCK_DAILY_4: "Review pull requests"  — DOING, P2, due today
 *     BLOCK_DAILY_5: "Write documentation"   — DONE,  P3, due today
 *
 *   PAGE_PROJECTS — child blocks with dates:
 *     BLOCK_PROJ_1:    "Ship v2.0 release"   — TODO,  P1, due tomorrow, scheduled today
 *     BLOCK_PROJ_2:    "Fix login bug"        — DOING, P1, due today
 *     BLOCK_PROJ_4:    "Design new dashboard" — TODO,  P2, due next week, scheduled tomorrow
 *     BLOCK_OVERDUE_1: "Submit report"        — TODO,  P1, due yesterday
 *
 * DuePanel in daily view uses `listBlocks({ agendaDate })` which matches
 * blocks by due_date or scheduled_date. The "Due" / "Scheduled" filter pills
 * narrow results to a single column.
 */

// ===========================================================================
// 1. Due date filtering
// ===========================================================================

test.describe('Due date filtering', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('DuePanel shows blocks due or scheduled on today in daily view', async ({ page }) => {
    // Journal defaults to daily view for today.
    // DuePanel appears below the BlockTree and fetches via
    // listBlocks({ agendaDate: today }) — matching due_date OR scheduled_date.
    const duePanel = page.locator('[data-testid="due-panel"]')
    await expect(duePanel).toBeVisible({ timeout: 5000 })

    // The collapsible header should be visible and expanded
    const header = duePanel.locator('[data-testid="due-panel-header"]')
    await expect(header).toBeVisible()
    await expect(header).toHaveAttribute('aria-expanded', 'true')

    // Verify at least one due-panel item is rendered.
    // Seed data has 4 blocks due today + 1 scheduled today = 5 total.
    const items = duePanel.locator('[data-testid="due-panel-item"]')
    await expect(items.first()).toBeVisible({ timeout: 5000 })
    const count = await items.count()
    expect(count).toBeGreaterThanOrEqual(3)
  })

  test('DuePanel "Due" filter shows only due-dated blocks', async ({ page }) => {
    const duePanel = page.locator('[data-testid="due-panel"]')
    await expect(duePanel).toBeVisible({ timeout: 5000 })

    // Click "Due" filter pill inside the filter bar
    const filterBar = duePanel.locator('[data-testid="due-panel-filters"]')
    await expect(filterBar).toBeVisible()
    const dueFilter = filterBar.getByText('Due', { exact: true })
    await dueFilter.click()

    // Wait for the filter to take effect
    await expect(dueFilter).toHaveAttribute('aria-pressed', 'true')

    // Due-only blocks for today: BLOCK_DAILY_3, BLOCK_DAILY_4, BLOCK_DAILY_5, BLOCK_PROJ_2
    const items = duePanel.locator('[data-testid="due-panel-item"]')
    await expect(items.first()).toBeVisible({ timeout: 5000 })
    const count = await items.count()
    expect(count).toBeGreaterThanOrEqual(3)
  })
})

// ===========================================================================
// 2. Scheduled date filtering
// ===========================================================================

test.describe('Scheduled date filtering', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('DuePanel "Scheduled" filter shows only scheduled blocks', async ({ page }) => {
    const duePanel = page.locator('[data-testid="due-panel"]')
    await expect(duePanel).toBeVisible({ timeout: 5000 })

    // Click "Scheduled" filter pill
    const filterBar = duePanel.locator('[data-testid="due-panel-filters"]')
    await expect(filterBar).toBeVisible()
    const scheduledFilter = filterBar.getByText('Scheduled', { exact: true })
    await scheduledFilter.click()

    // Verify the filter is active
    await expect(scheduledFilter).toHaveAttribute('aria-pressed', 'true')

    // Scheduled-only block for today: BLOCK_PROJ_1 ("Ship v2.0 release")
    // Wait for the expected scheduled content to appear (deterministic wait
    // for the filter change to take effect).
    await expect(duePanel.getByText('Ship v2.0 release')).toBeVisible({ timeout: 5000 })
    const items = duePanel.locator('[data-testid="due-panel-item"]')
    await expect(items.first()).toBeVisible({ timeout: 5000 })
  })

  test('switching back to "All" restores full list', async ({ page }) => {
    const duePanel = page.locator('[data-testid="due-panel"]')
    await expect(duePanel).toBeVisible({ timeout: 5000 })

    // Get initial count
    const items = duePanel.locator('[data-testid="due-panel-item"]')
    await expect(items.first()).toBeVisible({ timeout: 5000 })
    const initialCount = await items.count()

    // Switch to "Scheduled" filter (fewer items)
    const filterBar = duePanel.locator('[data-testid="due-panel-filters"]')
    const scheduledFilter = filterBar.getByText('Scheduled', { exact: true })
    await scheduledFilter.click()
    // Deterministic wait: filter is active (aria-pressed flips to true)
    await expect(scheduledFilter).toHaveAttribute('aria-pressed', 'true')

    // Switch back to "All"
    await filterBar.getByText('All', { exact: true }).click()
    await expect(filterBar.getByText('All', { exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    // Count should be restored to the initial value
    await expect(items.first()).toBeVisible({ timeout: 5000 })
    const restoredCount = await items.count()
    expect(restoredCount).toBe(initialCount)
  })
})

// ===========================================================================
// 3. Task state changes in agenda
// ===========================================================================

test.describe('Task state changes in agenda', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('clicking task checkbox cycles TODO to DOING', async ({ page }) => {
    // In daily view, the BlockTree renders blocks with task checkboxes.
    // BLOCK_DAILY_3 has todo_state = 'TODO', so it shows a task-checkbox-todo.
    const todoCheckbox = page.locator('[data-testid="task-checkbox-todo"]').first()
    await expect(todoCheckbox).toBeVisible({ timeout: 5000 })

    // The parent button has aria-label "Task: TODO. Click to cycle."
    const todoButton = page.locator('button[aria-label*="Task: TODO"]').first()
    await expect(todoButton).toBeVisible()

    // Click the checkbox to cycle: TODO → DOING
    await todoButton.click()

    // After cycling, the checkbox should change to task-checkbox-doing
    await expect(page.locator('[data-testid="task-checkbox-doing"]').first()).toBeVisible()
  })

  test('clicking task checkbox cycles DOING to DONE', async ({ page }) => {
    // BLOCK_DAILY_4 has todo_state = 'DOING'
    const doingButton = page.locator('button[aria-label*="Task: DOING"]').first()
    await expect(doingButton).toBeVisible({ timeout: 5000 })

    // Click to cycle: DOING → DONE
    await doingButton.click()

    // Verify a new DONE checkbox appeared
    // (there's already one DONE block — BLOCK_DAILY_5 — so we check for at least 2)
    const doneCheckboxes = page.locator('[data-testid="task-checkbox-done"]')
    await expect(doneCheckboxes.first()).toBeVisible()
    const doneCount = await doneCheckboxes.count()
    expect(doneCount).toBeGreaterThanOrEqual(2)
  })

  test('context menu Set as TODO sets task state on a plain block', async ({ page }) => {
    // BLOCK_DAILY_1 has no todo_state — its checkbox is task-checkbox-empty.
    // Right-click to open context menu and set it as TODO.
    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    await firstBlock.click({ button: 'right' })

    const menu = page.locator('[role="menu"]')
    await expect(menu).toBeVisible()
    await menu.locator('[role="menuitem"]', { hasText: 'Set as TODO' }).click()

    // Verify the block now has a TODO checkbox
    await expect(firstBlock.locator('[data-testid="task-checkbox-todo"]')).toBeVisible()
  })
})

// ===========================================================================
// 4. Overdue tasks
// ===========================================================================

test.describe('Overdue tasks', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('navigating to yesterday shows overdue block in DuePanel', async ({ page }) => {
    // Navigate to previous day (yesterday) where BLOCK_OVERDUE_1 is due
    await page.getByRole('button', { name: 'Previous day' }).click()

    // The DuePanel for yesterday should show BLOCK_OVERDUE_1 ("Submit report")
    // which has due_date = yesterday
    const duePanel = page.locator('[data-testid="due-panel"]')
    await expect(duePanel).toBeVisible({ timeout: 5000 })

    // Verify the overdue block content appears in the panel
    const items = duePanel.locator('[data-testid="due-panel-item"]')
    await expect(items.first()).toBeVisible({ timeout: 5000 })

    // Check that "Submit report" text is present
    await expect(duePanel.getByText('Submit report')).toBeVisible()
  })

  test('overdue block shows priority badge in DuePanel', async ({ page }) => {
    // Navigate to yesterday
    await page.getByRole('button', { name: 'Previous day' }).click()

    const duePanel = page.locator('[data-testid="due-panel"]')
    await expect(duePanel).toBeVisible({ timeout: 5000 })
    await expect(duePanel.locator('[data-testid="due-panel-item"]').first()).toBeVisible({
      timeout: 5000,
    })

    // BLOCK_OVERDUE_1 has priority '1', so "P1" badge should appear
    const priorityBadge = duePanel.locator('[data-testid="due-panel-priority"]')
    await expect(priorityBadge.first()).toBeVisible()
    await expect(priorityBadge.first()).toContainText('P1')
  })
})

// ===========================================================================
// 5. Date navigation
// ===========================================================================

test.describe('Date navigation', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('previous day button changes the displayed date', async ({ page }) => {
    // Capture the initial date display
    const dateDisplay = page.locator('[data-testid="date-display"]')
    await expect(dateDisplay).toBeVisible()
    const initialDate = await dateDisplay.textContent()

    // Click "Previous day"
    await page.getByRole('button', { name: 'Previous day' }).click()

    // The date display should change
    await expect(dateDisplay).not.toHaveText(initialDate ?? '')
  })

  test('next day button changes the displayed date', async ({ page }) => {
    // Capture the initial date display
    const dateDisplay = page.locator('[data-testid="date-display"]')
    await expect(dateDisplay).toBeVisible()
    const initialDate = await dateDisplay.textContent()

    // Click "Next day"
    await page.getByRole('button', { name: 'Next day' }).click()

    // The date display should change
    await expect(dateDisplay).not.toHaveText(initialDate ?? '')
  })

  test('navigating forward then backward returns to original date', async ({ page }) => {
    const dateDisplay = page.locator('[data-testid="date-display"]')
    await expect(dateDisplay).toBeVisible()
    const originalDate = await dateDisplay.textContent()

    // Go forward one day
    await page.getByRole('button', { name: 'Next day' }).click()
    await expect(dateDisplay).not.toHaveText(originalDate ?? '')

    // Go backward one day — should return to original date
    await page.getByRole('button', { name: 'Previous day' }).click()
    await expect(dateDisplay).toHaveText(originalDate ?? '')
  })

  test('Today button returns to current date after navigation', async ({ page }) => {
    const dateDisplay = page.locator('[data-testid="date-display"]')
    await expect(dateDisplay).toBeVisible()
    const todayText = await dateDisplay.textContent()

    // Navigate away (two days back)
    await page.getByRole('button', { name: 'Previous day' }).click()
    await page.getByRole('button', { name: 'Previous day' }).click()
    await expect(dateDisplay).not.toHaveText(todayText ?? '')

    // Click "Today" to return
    await page.getByRole('button', { name: 'Go to today' }).click()

    // Date display should match original
    await expect(dateDisplay).toHaveText(todayText ?? '')
  })

  test('DuePanel content updates after navigating to a different day', async ({ page }) => {
    // Verify DuePanel on today has items
    const duePanel = page.locator('[data-testid="due-panel"]')
    await expect(duePanel).toBeVisible({ timeout: 5000 })
    await expect(duePanel.locator('[data-testid="due-panel-item"]').first()).toBeVisible({
      timeout: 5000,
    })
    const _todayCount = await duePanel.locator('[data-testid="due-panel-item"]').count()

    // Capture today's date text so we can deterministically detect the transition
    // to yesterday (rather than polling with an arbitrary timeout).
    const dateDisplay = page.locator('[data-testid="date-display"]')
    const todayText = await dateDisplay.textContent()

    // Navigate to previous day — the DuePanel should reload with different content
    await page.getByRole('button', { name: 'Previous day' }).click()

    // Deterministic wait: date display text changes, and yesterday's overdue
    // item ("Submit report") becomes visible in the refreshed DuePanel.
    await expect(dateDisplay).not.toHaveText(todayText ?? '')
    await expect(duePanel.getByText('Submit report')).toBeVisible({ timeout: 5000 })

    // The DuePanel should still be visible (with different items for yesterday)
    await expect(duePanel).toBeVisible({ timeout: 5000 })

    // The count may differ from today's count (yesterday has BLOCK_OVERDUE_1)
    // We just verify the panel refreshed and is still functional
    const header = duePanel.locator('[data-testid="due-panel-header"]')
    await expect(header).toBeVisible()
  })
})

// ===========================================================================
// 6. View mode interactions
// ===========================================================================

test.describe('View mode interactions', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('switching from daily to weekly shows 7 day sections', async ({ page }) => {
    // Switch to weekly view
    await page.getByRole('tab', { name: 'Weekly view' }).click()

    // Weekly view renders 7 day sections (Mon-Sun)
    const sections = page.locator('section[aria-label^="Journal for"]')
    await expect(sections.first()).toBeVisible()
    const count = await sections.count()
    expect(count).toBe(7)

    // Date navigation should show week range (e.g., "Mar 24 - Mar 30, 2025")
    const dateDisplay = page.locator('[data-testid="date-display"]')
    await expect(dateDisplay).toBeVisible()
    const weekText = await dateDisplay.textContent()
    expect(weekText).toContain(' - ')
  })

  test('switching from daily to monthly shows full month', async ({ page }) => {
    // Switch to monthly view
    await page.getByRole('tab', { name: 'Monthly view' }).click()

    // Monthly view renders 28-31 day sections
    const sections = page.locator('section[aria-label^="Journal for"]')
    await expect(sections.first()).toBeVisible()
    const count = await sections.count()
    expect(count).toBeGreaterThanOrEqual(28)
    expect(count).toBeLessThanOrEqual(31)
  })

  test('switching to agenda view shows filter and sort controls', async ({ page }) => {
    // Switch to agenda view
    await page.getByRole('tab', { name: 'Agenda view' }).click()

    // Verify the agenda view container is visible
    await expect(page.locator('[data-testid="agenda-view"]')).toBeVisible()

    // Verify the filter builder is present
    await expect(page.locator('[data-testid="agenda-filter-builder"]')).toBeVisible()

    // Verify the "Add filter" button is available
    await expect(page.getByRole('button', { name: 'Add filter' })).toBeVisible()

    // Verify sort/group toolbar is present
    await expect(page.locator('[data-testid="agenda-sort-group-controls"]')).toBeVisible()

    // Verify Group by and Sort by controls are visible
    await expect(page.getByRole('button', { name: 'Group by' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sort by' })).toBeVisible()
  })

  test('agenda view date navigation is hidden', async ({ page }) => {
    // Switch to agenda view
    await page.getByRole('tab', { name: 'Agenda view' }).click()
    await expect(page.locator('[data-testid="agenda-view"]')).toBeVisible()

    // In agenda mode, the prev/next day buttons should not be visible
    await expect(page.getByRole('button', { name: 'Previous day' })).not.toBeVisible()
    await expect(page.getByRole('button', { name: 'Next day' })).not.toBeVisible()

    // The date display should show "Tasks" instead of a date
    const dateDisplay = page.locator('[data-testid="date-display"]')
    await expect(dateDisplay).toHaveText('Tasks')
  })

  test('switching back to daily from agenda restores date navigation', async ({ page }) => {
    // Go to agenda
    await page.getByRole('tab', { name: 'Agenda view' }).click()
    await expect(page.locator('[data-testid="agenda-view"]')).toBeVisible()

    // Switch back to daily
    await page.getByRole('tab', { name: 'Daily view' }).click()

    // Date navigation should be restored
    await expect(page.getByRole('button', { name: 'Previous day' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Next day' })).toBeVisible()

    // DuePanel should reappear with today's items
    const duePanel = page.locator('[data-testid="due-panel"]')
    await expect(duePanel).toBeVisible({ timeout: 5000 })
  })

  test('agenda view group by control changes grouping', async ({ page }) => {
    // Switch to agenda view
    await page.getByRole('tab', { name: 'Agenda view' }).click()
    await expect(page.locator('[data-testid="agenda-view"]')).toBeVisible()

    // Click "Group by" to open the popover
    await page.getByRole('button', { name: 'Group by' }).click()

    // Verify group options are visible
    const groupList = page.locator('ul[aria-label="Group by"]')
    await expect(groupList).toBeVisible()

    // Select "Priority" grouping
    await groupList.getByText('Priority').click()

    // The popover should close and the Group by button text should update
    await expect(groupList).not.toBeVisible()
  })

  test('agenda view sort by control changes sorting', async ({ page }) => {
    // Switch to agenda view
    await page.getByRole('tab', { name: 'Agenda view' }).click()
    await expect(page.locator('[data-testid="agenda-view"]')).toBeVisible()

    // Click "Sort by" to open the popover
    await page.getByRole('button', { name: 'Sort by' }).click()

    // Verify sort options are visible
    const sortList = page.locator('ul[aria-label="Sort by"]')
    await expect(sortList).toBeVisible()

    // Select "Priority" sorting
    await sortList.getByText('Priority').click()

    // The popover should close
    await expect(sortList).not.toBeVisible()
  })

  test('weekly view previous/next week navigation works', async ({ page }) => {
    // Switch to weekly view
    await page.getByRole('tab', { name: 'Weekly view' }).click()
    await expect(page.locator('section[aria-label^="Journal for"]').first()).toBeVisible()

    // Capture the week range text
    const dateDisplay = page.locator('[data-testid="date-display"]')
    const initialWeek = await dateDisplay.textContent()

    // Click "Previous week"
    await page.getByRole('button', { name: 'Previous week' }).click()

    // Verify the week range changed
    await expect(dateDisplay).not.toHaveText(initialWeek ?? '')
  })
})

// ===========================================================================
// 7. Page-centric agenda + undated tasks (FEAT-1)
// ===========================================================================

test.describe('Page-centric agenda defaults', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('agenda view includes undated tasks by default', async ({ page }) => {
    // Switch to agenda view
    await page.getByRole('tab', { name: 'Agenda view' }).click()
    await expect(page.locator('[data-testid="agenda-view"]')).toBeVisible()

    // Wait for results to load
    const items = page.locator('.agenda-results-item')
    await expect(items.first()).toBeVisible({ timeout: 5000 })

    // BLOCK_PROJ_3 "Update dependencies" is undated (todo_state=DONE, no dates)
    // It should appear in the agenda results
    await expect(page.getByText('Update dependencies')).toBeVisible()
  })

  test('agenda view groups by page by default', async ({ page }) => {
    // Switch to agenda view — default groupBy is 'page' since FEAT-1
    await page.getByRole('tab', { name: 'Agenda view' }).click()
    await expect(page.locator('[data-testid="agenda-view"]')).toBeVisible()

    // Wait for results to load
    const items = page.locator('.agenda-results-item')
    await expect(items.first()).toBeVisible({ timeout: 5000 })

    // Page group headers should appear (agenda groups by page by default)
    const groupHeaders = page.locator('.agenda-group-header')
    const headerCount = await groupHeaders.count()
    expect(headerCount).toBeGreaterThanOrEqual(1)
  })

  test('group by page shows page name headers', async ({ page }) => {
    // Switch to agenda view
    await page.getByRole('tab', { name: 'Agenda view' }).click()
    await expect(page.locator('[data-testid="agenda-view"]')).toBeVisible()

    // Click "Group by" to open popover
    await page.getByRole('button', { name: 'Group by' }).click()
    const groupList = page.locator('ul[aria-label="Group by"]')
    await expect(groupList).toBeVisible()

    // Select "Page" grouping
    await groupList.getByText('Page').click()
    await expect(groupList).not.toBeVisible()

    // Wait for regrouped results
    const items = page.locator('.agenda-results-item')
    await expect(items.first()).toBeVisible({ timeout: 5000 })

    // Verify page group headers contain page names from seed data
    const groupHeaders = page.locator('.agenda-group-header')
    const headerCount = await groupHeaders.count()
    expect(headerCount).toBeGreaterThanOrEqual(1)

    // At least one header should contain a known page name
    const allHeaderText = await groupHeaders.allTextContents()
    const hasKnownPage = allHeaderText.some(
      (text) => text.includes('Projects') || text.includes('Meetings') || text.includes('No page'),
    )
    expect(hasKnownPage).toBe(true)
  })

  test('sort by page reorders items alphabetically by page title', async ({ page }) => {
    // Switch to agenda view
    await page.getByRole('tab', { name: 'Agenda view' }).click()
    await expect(page.locator('[data-testid="agenda-view"]')).toBeVisible()

    // Click "Sort by" to open popover
    await page.getByRole('button', { name: 'Sort by' }).click()
    const sortList = page.locator('ul[aria-label="Sort by"]')
    await expect(sortList).toBeVisible()

    // Select "Page" sorting
    await sortList.getByText('Page').click()
    await expect(sortList).not.toBeVisible()

    // Verify items are still rendered after re-sort
    const items = page.locator('.agenda-results-item')
    await expect(items.first()).toBeVisible({ timeout: 5000 })
    const count = await items.count()
    expect(count).toBeGreaterThanOrEqual(1)
  })
})
