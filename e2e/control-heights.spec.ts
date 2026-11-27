/**
 * One height for the framed controls (#7165). On a coarse pointer a text
 * input, a button, a select trigger and a segmented toggle are all 36 px, as on
 * a fine one; the buttons take their 44 px target invisibly. A switch is a
 * compact 24 px with a 44 px hit area, its on track the brand coral and its off
 * track a neutral grey, and a segmented toggle fills its row's width without
 * stretching down a flex column.
 */

import { devices, type Locator, type Page } from '@playwright/test'

import { expect, expect44, navigateToView, openSettingsTab, test, waitForBoot } from './helpers'

const { defaultBrowserType: _browser, ...pixel7 } = devices['Pixel 7']

const PROFILES = [
  { name: 'phone', use: pixel7 },
  { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
] as const

async function height(el: Locator): Promise<number> {
  await el.scrollIntoViewIfNeeded()
  const box = await el.boundingBox()
  if (box === null) throw new Error('control has no box')
  return Math.round(box.height)
}

/** The colour a token resolves to, as `getComputedStyle` writes a background. */
function tokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate((t) => {
    const probe = document.createElement('div')
    probe.style.backgroundColor = `var(${t})`
    document.body.append(probe)
    const color = getComputedStyle(probe).backgroundColor
    probe.remove()
    return color
  }, token)
}

for (const profile of PROFILES) {
  test.describe(`control heights on ${profile.name} @settings @search @mobile`, () => {
    test.use(profile.use)

    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await waitForBoot(page)
    })

    test('an input is as tall as the buttons in its row', async ({ page }) => {
      await navigateToView(page, 'Tags')
      const tagName = page.getByPlaceholder('New tag name...')
      const addTag = page.getByRole('button', { name: 'Add tag' })
      expect(await height(tagName), 'Tags input').toBe(36)
      expect(await height(addTag), 'Add tag').toBe(36)

      await navigateToView(page, 'Pages')
      const header = page.locator('.page-browser-header')
      expect(await height(header.getByPlaceholder('Search pages...')), 'Pages search').toBe(36)
      const newPage = header.getByRole('button', { name: 'New page', exact: true })
      expect(await height(newPage), 'New page').toBe(36)
      if (profile.name === 'phone') {
        // On a phone, New page and the sort button are 36 px squares.
        for (const [name, el] of [
          ['New page', newPage],
          ['Sort order', header.getByRole('combobox', { name: 'Sort order' })],
        ] as const) {
          expect((await el.boundingBox())?.width, `${name} width`).toBe(36)
          await expect44(el, name)
        }
      }
    })

    test('a select and a segmented toggle are as tall as the buttons', async ({ page }) => {
      await navigateToView(page, 'Advanced query')
      const input = page.getByPlaceholder('Search block text…')
      const addSort = page.getByRole('button', { name: 'Add sort', exact: true })
      const select = page.getByRole('combobox', { name: 'Group by' })
      const view = page.getByRole('radiogroup', { name: 'View' })
      const not = page.getByRole('button', { name: 'NOT', exact: true })
      const match = page.getByRole('radiogroup', { name: 'Match' })
      await expect(input).toBeVisible()

      if (profile.name === 'phone') {
        for (const [name, el] of [
          ['input', input],
          ['Add sort', addSort],
          ['select', select],
          ['View toggle', view],
          ['Match toggle', match],
        ] as const) {
          expect(await height(el), name).toBe(36)
        }
        await expect44(addSort, 'Add sort')
      } else {
        // A fine pointer keeps the compact sizes: each matches its row.
        expect(await height(select), 'select').toBe(await height(addSort))
        expect(await height(match), 'Match toggle').toBe(await height(not))
      }
    })

    test('a switch is compact, centred on its row, and coral when on', async ({ page }) => {
      await navigateToView(page, 'Settings')
      await openSettingsTab(page, 'Tasks & reminders')
      const sw = page.getByRole('switch', { name: 'Remind me about due tasks' })
      await expect(sw).toHaveAttribute('aria-checked', 'false')

      const box = await sw.boundingBox()
      if (box === null) throw new Error('switch has no box')
      expect(box.height).toBeLessThanOrEqual(24)
      if (profile.name === 'phone') await expect44(sw, 'switch')

      const row = page.locator('[data-slot="setting-row"]').filter({ has: sw })
      const rowBox = await row.boundingBox()
      if (rowBox === null) throw new Error('row has no box')
      expect(Math.abs(box.y + box.height / 2 - (rowBox.y + rowBox.height / 2))).toBeLessThan(1)

      const track = () => sw.evaluate((el) => getComputedStyle(el).backgroundColor)
      const offGrey = () =>
        page.evaluate(() => {
          const probe = document.createElement('div')
          probe.className = 'bg-muted-foreground/40'
          document.body.append(probe)
          const color = getComputedStyle(probe).backgroundColor
          probe.remove()
          return color
        })
      const thumb = () =>
        sw
          .locator('[data-slot="switch-thumb"]')
          .evaluate((el) => getComputedStyle(el).backgroundColor)
      const white = 'rgb(255, 255, 255)'
      for (const dark of [false, true]) {
        await page.evaluate((on) => document.documentElement.classList.toggle('dark', on), dark)
        const theme = dark ? 'dark' : 'light'
        await expect(sw).toHaveAttribute('aria-checked', 'false')
        expect(await track(), `${theme} off track`).toBe(await offGrey())
        expect(await thumb(), `${theme} thumb on the off track`).toBe(white)
        await sw.click()
        await expect(sw).toHaveAttribute('aria-checked', 'true')
        expect(await track(), `${theme} on track`).toBe(await tokenColor(page, '--brand'))
        expect(await thumb(), `${theme} thumb on the on track`).toBe(white)
        await sw.click()
      }
    })
  })
}

test.describe('a segmented toggle in a flex column @search @mobile', () => {
  test.use(pixel7)

  test('does not stretch down the column', async ({ page }) => {
    await waitForBoot(page)
    await page.getByTestId('search-sheet-trigger').click()
    const sheet = page.getByTestId('search-sheet')
    await expect(sheet).toBeVisible()
    await sheet.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
    // All pages gives the sheet a fixed height, room a `grow` would take.
    const allPages = page.getByTestId('search-sheet-segment-all-pages')
    await allPages.click()
    await expect(allPages).toHaveAttribute('aria-checked', 'true')
    expect(await height(sheet.getByRole('radiogroup').first())).toBe(36)
  })
})
