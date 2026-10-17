import type { Page } from '@playwright/test'

import { expect, test, waitForBoot } from './helpers'

/**
 * Dragging the sidebar rail resizes the sidebar, and the next launch opens at
 * that width: the drag writes the device-scoped `sidebar_width` preference to
 * localStorage, and the sidebar reads it when it mounts. A second page of the
 * same browser context shares that localStorage, so booting one is the next
 * launch. Frontend-only state, so the mock-backed build shows it.
 *
 * No navigate-away-and-back check: `SidebarProvider` sits at the App root and
 * never remounts, so no change to the width code could redden one.
 */

const DRAG_PX = 120

const sidebarWidth = async (page: Page) =>
  (await page.locator('[data-slot="sidebar-container"]').boundingBox())?.width

test('a dragged sidebar width is the width the next launch opens at', async ({ page }) => {
  await waitForBoot(page)
  const startWidth = await sidebarWidth(page)
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
  await expect.poll(() => sidebarWidth(page)).toBe(widened)

  const nextLaunch = await page.context().newPage()
  await waitForBoot(nextLaunch)
  await expect.poll(() => sidebarWidth(nextLaunch)).toBe(widened)
})
