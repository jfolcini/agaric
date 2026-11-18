import { expect, navigateToView, test, typeSlashCommand, waitForBoot } from './helpers'

/**
 * #6567 — a day's due count in the week view follows a date set in that view.
 *
 * `/due` writes `due_date`; the per-day count reads `agenda_cache`, which the
 * real backend rebuilds whole, in the background, after the command answered,
 * and the view reads again a debounce after the write. A view that read before
 * the rebuild kept the old count. This spec's bridge starts every background
 * batch a second late, so the rebuild outlasts the debounce, and the spec never
 * leaves the week view between the write and the count. The mock keeps no such
 * cache.
 */
test.use({ slowMaterializerMs: 1000 })

const TASK = 'counted once it is due'

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

test('the week view counts a task made due today, without leaving the view @journal', async ({
  page,
}) => {
  await waitForBoot(page)
  await navigateToView(page, 'Journal')
  await page.getByRole('tab', { name: 'Weekly view' }).click()
  const today = page.locator(`section[id="journal-${todayStr()}"]`)
  await today.scrollIntoViewIfNeeded()
  // The seed already has tasks due today.
  const count = today.getByRole('button', { name: /^\d+ Due items?, click to view$/ })
  await expect(count).toBeVisible()
  const before = Number(/^\d+/.exec((await count.getAttribute('aria-label')) ?? '')?.[0])

  await today.getByRole('button', { name: 'Add block', exact: true }).click()
  await expect(today.locator('[data-testid="block-editor"] [contenteditable="true"]')).toBeFocused()
  await page.keyboard.type(TASK)
  await typeSlashCommand(page, 'due')
  await page.locator('#suggestion-due').click()
  const picker = page.locator('[data-testid="date-picker-popup"]')
  await picker.getByRole('textbox').fill('today')
  await page.keyboard.press('Enter')
  await expect(picker).toBeHidden()
  await expect(
    today.locator('[data-testid="sortable-block"]', { hasText: TASK }).locator('.due-date-chip'),
  ).toBeVisible()

  await expect(
    today.getByRole('button', { name: `${before + 1} Due items, click to view`, exact: true }),
  ).toBeVisible()
})
