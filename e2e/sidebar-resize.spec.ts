import { expect, navigateToView, openPage, test, waitForBoot } from './helpers'

/**
 * Dragging the sidebar rail resizes the sidebar, and the width outlives a
 * trip through other views. The width lives in `SidebarProvider` at the App
 * root, which navigation does not remount, and is persisted to the
 * device-scoped `sidebar_width` preference that the next launch reads; the
 * spec asserts both. Frontend-only state, so the mock-backed build shows it.
 */

const DRAG_PX = 120

test('a dragged sidebar width is kept across navigation and stored', async ({ page }) => {
  await waitForBoot(page)
  const sidebar = page.locator('[data-slot="sidebar-container"]')
  const widthOf = async () => (await sidebar.boundingBox())?.width
  const startWidth = await widthOf()
  if (startWidth === undefined) throw new Error('the sidebar has no layout box')

  const rail = await page.locator('[data-slot="sidebar-rail"]').boundingBox()
  if (rail === null) throw new Error('the sidebar rail has no layout box')
  const x = rail.x + rail.width / 2
  const y = rail.y + rail.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + DRAG_PX, y, { steps: 6 })
  await page.mouse.up()
  const widened = startWidth + DRAG_PX
  await expect.poll(widthOf).toBe(widened)

  await openPage(page, 'Getting Started')
  await navigateToView(page, 'Journal')
  await expect(page.getByRole('tablist', { name: 'Journal view mode' })).toBeVisible()

  await expect.poll(widthOf).toBe(widened)
  expect(await page.evaluate(() => localStorage.getItem('sidebar_width'))).toBe(String(widened))
})
