import type { Locator, Page } from '@playwright/test'

import {
  expect,
  navigateToView,
  openPage,
  openSettingsTab,
  switchToSpace,
  test,
  waitForBoot,
} from './helpers'

/**
 * Spaces happy paths (#5739): the "Open on launch" setting, per-space tabs /
 * recents / journal date restored on a switch, and the collapsed sidebar's
 * accent badge cycling the active space. All three are frontend state over
 * the mock's `list_spaces`, so the mock-backed build can show each failing.
 *
 * The second space is the mock's opt-in `SPACE_WORK` seed ("Work", no accent
 * colour; `src/lib/tauri-mock/seed.ts`), next to the seeded `SPACE_PERSONAL`
 * ("Personal", `accent-emerald`).
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('__mockWorkSpace', 'true'))
  await waitForBoot(page)
})

async function openSpacesSettings(page: Page): Promise<Locator> {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Spaces')
  const panel = page.getByTestId('settings-panel-spaces')
  await expect(panel).toBeVisible()
  return panel
}

const pageTitle = (page: Page) => page.locator('[aria-label="Page title"]')
const dateDisplay = (page: Page) => page.getByTestId('date-display')
const editorTabs = (page: Page) =>
  page.getByRole('tablist', { name: 'Editor tabs' }).getByRole('tab')
const recentChips = (page: Page) =>
  page.getByTestId('quick-access-bar').locator('[data-slot="recent-page-chip"]')

test('Open on launch keeps the chosen space, and falls back to Last used once a peer deletes it', async ({
  page,
}) => {
  const panel = await openSpacesSettings(page)
  const openOnLaunch = panel.getByRole('combobox', { name: 'Open on launch', exact: true })
  await openOnLaunch.click()
  await page.getByRole('option', { name: 'Work', exact: true }).click()
  await expect(openOnLaunch).toHaveText('Work')

  await navigateToView(page, 'Journal')
  await openSpacesSettings(page)
  await expect(openOnLaunch).toHaveText('Work')

  // Work is deleted on another device: the mock store loses the space block,
  // then `sync:complete` refreshes the list.
  await page.evaluate(async () => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
      __emitMockEvent: (event: string, payload?: unknown) => Promise<void>
    }
    await w.__TAURI_INTERNALS__.invoke('delete_block', { blockId: 'SPACE_WORK' })
    await w.__emitMockEvent('sync:complete', {
      type: 'complete',
      remote_device_id: 'device-b',
      ops_received: 1,
      ops_sent: 0,
      changed_blocks: 1,
      changed_page_ids: ['SPACE_WORK'],
    })
  })
  await expect(panel.locator('[data-slot="space-manage-row"]')).toHaveCount(1)

  await navigateToView(page, 'Journal')
  await openSpacesSettings(page)
  await expect(openOnLaunch).toHaveText('Last used')
})

test('switching spaces restores each space its own tabs, recent pages and journal date', async ({
  page,
}) => {
  await expect(dateDisplay(page)).toBeVisible()
  const todayText = (await dateDisplay(page).textContent()) ?? ''

  // Work's journal moves to yesterday.
  await switchToSpace(page, 'Work')
  await navigateToView(page, 'Journal')
  await expect(dateDisplay(page)).toHaveText(todayText)
  await page.getByRole('button', { name: 'Previous day', exact: true }).click()
  await expect(dateDisplay(page)).not.toHaveText(todayText)
  const yesterdayText = (await dateDisplay(page).textContent()) ?? ''

  // Personal's journal is still on today; then two tabs and two recents.
  await switchToSpace(page, 'Personal')
  await expect(dateDisplay(page)).toHaveText(todayText)
  for (const title of ['Getting Started', 'Quick Notes', 'Projects']) {
    await openPage(page, title)
    await expect(pageTitle(page)).toHaveText(title)
  }
  await page
    .getByTestId('quick-access-bar')
    .getByRole('button', { name: 'Quick Notes', exact: true })
    .click({ modifiers: ['ControlOrMeta'] })
  await expect(editorTabs(page)).toHaveCount(2)
  await expect(recentChips(page)).toHaveText(['Quick Notes', 'Getting Started'])

  await switchToSpace(page, 'Work')
  await expect(dateDisplay(page)).toHaveText(yesterdayText)
  await expect(editorTabs(page)).toHaveCount(0)
  await expect(recentChips(page)).toHaveCount(0)

  await switchToSpace(page, 'Personal')
  await expect(editorTabs(page)).toHaveText([/Projects/, /Quick Notes/])
  await expect(editorTabs(page).first()).toHaveAttribute('aria-selected', 'true')
  await expect(pageTitle(page)).toHaveText('Projects')
  await expect(recentChips(page)).toHaveText(['Quick Notes', 'Getting Started'])
})

test('in the collapsed sidebar, the space badge switches to the next space', async ({ page }) => {
  await navigateToView(page, 'Pages')
  await expect(
    page.locator('[data-page-item]').filter({ hasText: 'Getting Started' }),
  ).toBeVisible()

  const sidebar = page.locator('[data-slot="sidebar"]')
  await sidebar.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed')

  // Resolve an accent token the way the stripe's `var()` does.
  const tokenColour = (token: string) =>
    page.evaluate((t) => {
      const probe = document.createElement('div')
      probe.style.backgroundColor = `var(--${t})`
      document.body.append(probe)
      const colour = getComputedStyle(probe).backgroundColor
      probe.remove()
      return colour
    }, token)
  const stripe = page.getByTestId('space-top-stripe')
  const stripeColour = () => stripe.evaluate((el) => getComputedStyle(el).backgroundColor)
  await expect.poll(stripeColour).toBe(await tokenColour('accent-emerald'))

  await sidebar
    .getByRole('button', { name: 'Personal space — click to switch', exact: true })
    .click()

  // Work has no accent of its own, so it shows the default (`DEFAULT_ACCENT_TOKEN`).
  await expect.poll(stripeColour).toBe(await tokenColour('accent-blue'))
  await expect(stripe).toHaveAttribute('data-space-id', 'SPACE_WORK')
  await expect(
    sidebar.getByRole('button', { name: 'Work space — click to switch', exact: true }),
  ).toBeVisible()
  await sidebar.getByRole('button', { name: 'Pages', exact: true }).click()
  await expect(page.getByText('No pages outside the journal yet.', { exact: true })).toBeVisible()
  await expect(page.locator('[data-page-item]')).toHaveCount(0)
})
