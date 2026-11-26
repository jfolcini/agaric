/**
 * E2E — #7040 O7, P5 and P11: the two block side sheets share one width and
 * the properties sheet reads as a form, not a row of buttons; the Pages list
 * offers the same row actions on top-level and namespace rows and loads into
 * the list's own card; the phone drawer's footer holds labelled Sync and
 * Settings rows, as tall as the navigation rows, with the sync state in words.
 */

import { devices, type Locator, type Page } from '@playwright/test'

import {
  createPageFromPagesView,
  expect,
  focusBlock,
  navigateMobile,
  openMobileSidebar,
  openPage,
  test,
  waitForBoot,
} from './helpers'

const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7']
const phone = { ...pixel, viewport: { width: 412, height: 915 } }

async function chord(page: Page, key: string): Promise<void> {
  await page.keyboard.press(`Control+Shift+${key}`)
}

/** Whether `el` or an ancestor below the property row draws a border. */
function bordered(label: Locator): Promise<boolean> {
  return label.evaluate((el) => {
    for (let n: Element | null = el; n && !n.matches('.grid'); n = n.parentElement) {
      if (Number.parseFloat(getComputedStyle(n).borderTopWidth) > 0) return true
    }
    return false
  })
}

test.describe('Block side sheets @editor', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Block properties and Block history open at the same width', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)
    await chord(page, 'P')
    const properties = page.getByRole('dialog', { name: 'Block properties' })
    await expect(properties).toBeVisible()
    const propertiesWidth = (await properties.boundingBox())?.width
    await page.keyboard.press('Escape')
    await expect(properties).toBeHidden()

    await focusBlock(page)
    await chord(page, 'Y')
    const history = page.getByRole('dialog', { name: 'Block history' })
    await expect(history).toBeVisible()
    // The two boxes can round a sub-pixel apart.
    expect((await history.boundingBox())?.width).toBeCloseTo(propertiesWidth ?? 0, 0)
  })

  test('a property name is a plain label and a date reads as it does on the chip', async ({
    page,
  }) => {
    const row = page.locator('[data-testid="sortable-block"]', { hasText: 'Buy groceries' })
    const chip = row.getByRole('button', { name: /^Due / })
    await expect(chip).toBeVisible()
    const chipText = ((await chip.textContent()) ?? '').trim()

    await row.getByText('Buy groceries').click()
    await expect(row.locator('[contenteditable="true"]')).toBeFocused()
    await chord(page, 'P')
    const sheet = page.getByRole('dialog', { name: 'Block properties' })
    const due = sheet.getByRole('textbox', { name: 'Due value' })
    await expect(due).toBeVisible()

    expect(await bordered(sheet.getByText('Due', { exact: true }))).toBe(false)
    await expect(due).toHaveValue(chipText)
  })
})

test.describe('Pages list rows @pages', () => {
  test('the loading skeleton sits in the list card, one row per divider', async ({ page }) => {
    await waitForBoot(page)
    await page.evaluate(() => {
      ;(window as unknown as { __setMockLatency: (ms: number) => void }).__setMockLatency(5000)
    })
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Pages', exact: true })
      .click()
    const skeleton = page.getByTestId('page-browser-loading')
    await expect(skeleton).toBeVisible()
    const shape = await skeleton.evaluate((el) => ({
      border: getComputedStyle(el).borderTopWidth,
      dividers: [...el.children].map((row) => getComputedStyle(row, '::after').content),
    }))
    expect(shape).toEqual({ border: '1px', dividers: ['""', '""', 'none'] })
    await page.evaluate(() => {
      ;(window as unknown as { __setMockLatency: (ms: number) => void }).__setMockLatency(0)
    })
  })

  test.describe('on a touch phone', () => {
    test.use(phone)

    test('a namespace child shows no bin, like a top-level row @mobile', async ({ page }) => {
      await waitForBoot(page)
      await navigateMobile(page, 'Pages')
      await createPageFromPagesView(page, 'work/project-a')
      await navigateMobile(page, 'Pages')
      const grid = page.getByRole('grid')
      await expect(grid.locator('[data-page-tree-row]')).toContainText('project-a')
      await expect(grid.getByRole('button', { name: 'Delete page' }).first()).toBeHidden()
      await expect(grid.getByRole('button', { name: 'Delete work/project-a' })).toBeHidden()
    })
  })
})

test.describe('Phone drawer footer @mobile @sync @settings', () => {
  test.use(phone)

  test('Sync and Settings are labelled rows as tall as a nav row, sync state in words', async ({
    page,
  }) => {
    await waitForBoot(page)
    const drawer = await openMobileSidebar(page)
    const nav = drawer.getByRole('button', { name: 'Pages', exact: true })
    const settings = drawer.getByRole('button', { name: 'Settings', exact: true })
    const sync = drawer.getByRole('button', { name: 'Sync', exact: true })

    await expect(settings).toHaveText('Settings')
    await expect(sync).toContainText('Sync')
    // The mock pairs no device.
    await expect(sync.getByText('No devices paired')).toBeVisible()

    const navHeight = (await nav.boundingBox())?.height
    expect((await settings.boundingBox())?.height).toBe(navHeight)
    expect((await sync.boundingBox())?.height).toBe(navHeight)
  })
})
