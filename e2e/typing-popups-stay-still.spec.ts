import { devices, type Locator, type Page } from '@playwright/test'

import { expect, ipc, navigateMobile, openPage, test, waitForBoot } from './helpers'

/**
 * A popup the user types into keeps its input where it opened while the
 * results narrow: the command palette and the ref-property value picker.
 */

const GS5 = '0000000000000000000B10CK05'

/** Type `text` one key at a time and return the input's top after each key and once `last` shows. */
async function topsWhileTyping(page: Page, input: Locator, text: string, last: Locator) {
  const tops: number[] = []
  for (const ch of text) {
    await page.keyboard.type(ch)
    await expect(input).toHaveValue(new RegExp(`${ch}$`))
    tops.push((await input.boundingBox())?.y ?? Number.NaN)
  }
  await expect(last).toBeVisible()
  tops.push((await input.boundingBox())?.y ?? Number.NaN)
  return tops
}

/** The opening animation has finished, so the next measurement is the resting position. */
async function settled(surface: Locator): Promise<void> {
  await expect.poll(() => surface.evaluate((el) => el.getAnimations().length)).toBe(0)
}

function maxDrift(tops: number[], from: number): number {
  return Math.max(...tops.map((top) => Math.abs(top - from)))
}

test.describe('Typing into a popup keeps its input still @editor', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('the command palette input stays put as results narrow', async ({ page }) => {
    await page.getByTestId('header-search-button').click()
    const input = page.getByTestId('command-palette-input')
    await expect(input).toBeFocused()
    await settled(page.getByTestId('command-palette'))
    const opened = (await input.boundingBox())?.y ?? Number.NaN
    const tops = await topsWhileTyping(
      page,
      input,
      'Getti',
      page.getByRole('option', { name: /Getting Started/ }).first(),
    )
    expect(maxDrift(tops, opened)).toBeLessThanOrEqual(0.5)
  })

  test('the ref-property picker opened above its chip stays above', async ({ page }) => {
    // A text value under a key later defined as `ref` opens the page picker.
    await ipc(page, 'set_property', { blockId: GS5, key: 'owner', value: { value_text: 'x' } })
    await ipc(page, 'create_property_def', {
      spaceId: 'SPACE_PERSONAL',
      key: 'owner',
      valueType: 'ref',
      options: null,
    })
    await openPage(page, 'Getting Started')
    // The real backend answers after the popup's first placement, which sees
    // only a plain input; the mock answers before it unless delayed.
    await page.evaluate(() => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> })
        .__TAURI_INTERNALS__
      const invoke = internals['invoke'] as (cmd: string, ...rest: unknown[]) => Promise<unknown>
      internals['invoke'] = async (cmd: string, ...rest: unknown[]) => {
        if (cmd === 'get_property_def' || cmd === 'list_blocks') {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        return invoke(cmd, ...rest)
      }
    })
    const chip = page.getByText('x', { exact: true }).last()
    const box = await chip.boundingBox()
    const viewport = page.viewportSize()
    if (!box || !viewport) throw new Error('no chip or viewport')
    // Too little room below the chip for the full list.
    await page.setViewportSize({
      width: viewport.width,
      height: Math.round(box.y + box.height + 40),
    })
    await chip.click()
    const picker = page.getByTestId('ref-picker')
    const input = page.getByTestId('ref-search-input')
    await expect(input).toBeFocused()
    await expect(picker.getByRole('button').first()).toBeVisible()
    const opened = (await input.boundingBox())?.y ?? Number.NaN
    const pickerBox = await picker.boundingBox()
    expect((pickerBox?.y ?? Number.NaN) + (pickerBox?.height ?? 0)).toBeLessThan(box.y)
    const tops = await topsWhileTyping(
      page,
      input,
      'Getti',
      picker.getByRole('button', { name: 'Getting Started' }),
    )
    expect(maxDrift(tops, opened)).toBeLessThanOrEqual(0.5)
  })
})

const phone = devices['Pixel 7']

test.describe('Typing into the mobile search sheet keeps its input still @search @mobile', () => {
  test.use({
    viewport: phone.viewport,
    hasTouch: phone.hasTouch,
    isMobile: phone.isMobile,
    deviceScaleFactor: phone.deviceScaleFactor,
    userAgent: phone.userAgent,
  })

  test('the all-pages input stays put as results narrow', async ({ page }) => {
    await waitForBoot(page)
    await navigateMobile(page, 'Pages')
    await page.getByTestId('search-sheet-trigger').click()
    const input = page.getByTestId('command-palette-input')
    await expect(input).toBeFocused()
    await settled(page.getByTestId('search-sheet'))
    const opened = (await input.boundingBox())?.y ?? Number.NaN
    const tops = await topsWhileTyping(
      page,
      input,
      'Getti',
      page.getByRole('option', { name: /Getting Started/ }).first(),
    )
    expect(maxDrift(tops, opened)).toBeLessThanOrEqual(0.5)
  })
})
