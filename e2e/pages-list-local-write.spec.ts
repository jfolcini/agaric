import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import { expect, ipc, navigateToView, test, waitForBoot } from './helpers'

/**
 * #6545 — a page another surface creates (an agent, a script) appears in the
 * open Pages list without leaving the view. Nothing in the frontend knows of
 * the raw command, so the list hears of it only through the backend's change
 * feed: the `blocks:changed` it sends for a local command.
 */
const createPageElsewhere = (page: import('@playwright/test').Page, title: string) =>
  ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SEED_IDS.SPACE_PERSONAL,
  })

test('the open Pages list shows each page created elsewhere @pages', async ({ page }) => {
  await waitForBoot(page)
  await createPageElsewhere(page, 'Made elsewhere first')
  await navigateToView(page, 'Pages')
  const grid = page.getByRole('grid')
  await expect(grid.getByText('Made elsewhere first', { exact: true })).toBeVisible()

  await createPageElsewhere(page, 'Made elsewhere second')

  await expect(grid.getByText('Made elsewhere second', { exact: true })).toBeVisible()
})
