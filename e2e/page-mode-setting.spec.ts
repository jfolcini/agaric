/**
 * Page mode's setting and switch (#5691) against the mock backend: Settings ›
 * Editor › *Edit pages as* opens pages in page mode; a page header's Blocks |
 * Page switch, and Ctrl+Shift+M, change only the page on screen; a page holding
 * what page mode cannot show yet, or over its cap, keeps block mode and the
 * switch says why; a phone offers neither. Axe on the settings row and the
 * switch.
 */

import { createRequire } from 'node:module'

import { devices, type Page } from '@playwright/test'

import {
  expect,
  navigateMobile,
  navigateToView,
  openPageMobile,
  openSettingsTab,
  test,
  waitForBoot,
} from './helpers'

const axePath = createRequire(import.meta.url).resolve('axe-core')
const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const EDITOR = '[data-testid="page-mode-editor"]'

interface MockWindow {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
}

/** A page titled `title` holding `texts`, top-level; resolves the blocks' ids. */
function seedPage(page: Page, title: string, texts: readonly string[]): Promise<string[]> {
  return page.evaluate(
    async ({ title: t, texts: rows, scope }) => {
      const call = (cmd: string, args: Record<string, unknown>) =>
        (window as unknown as MockWindow).__TAURI_INTERNALS__.invoke(cmd, args)
      const pageId = (await call('create_page_in_space', {
        parentId: null,
        content: t,
        spaceId: scope.space_id,
      })) as string
      const { blocks } = (await call('create_blocks_batch', {
        specs: rows.map((content) => ({
          blockType: 'content',
          content,
          parentId: pageId,
          position: null,
        })),
      })) as { blocks: Array<{ id: string }> }
      return blocks.map((b) => b.id)
    },
    { title, texts, scope: SCOPE },
  )
}

async function openViaPalette(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+k')
  await page.locator('[cmdk-input]').first().fill(title)
  await page.locator('[cmdk-item]').filter({ hasText: title }).first().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
}

function modeSwitch(page: Page, name: 'Blocks' | 'Page') {
  return page.getByRole('radiogroup', { name: 'Editing mode' }).getByRole('radio', { name })
}

/** Axe violations inside `selector`. */
async function axeViolations(page: Page, selector: string): Promise<string[]> {
  await page.addScriptTag({ path: axePath })
  return page.evaluate(async (s) => {
    const { violations } = await (
      window as unknown as {
        axe: { run: (el: Element) => Promise<{ violations: Array<{ id: string }> }> }
      }
    ).axe.run(document.querySelector(s) as Element)
    return violations.map((v) => v.id)
  }, selector)
}

async function chooseInSettings(page: Page, mode: 'Blocks' | 'Page'): Promise<void> {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Editor')
  await page.getByRole('combobox', { name: 'Edit pages as' }).click()
  await page.getByRole('option', { name: mode, exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Edit pages as' })).toHaveText(mode)
}

test.describe('page mode’s setting and switch (#5691)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Edit pages as: Page opens pages in page mode, and the row passes axe', async ({ page }) => {
    await seedPage(page, 'By the setting', ['alpha', 'beta'])
    await chooseInSettings(page, 'Page')
    expect(await axeViolations(page, '[data-testid="edit-mode-select"]')).toEqual([])
    expect(await axeViolations(page, 'main')).toEqual([])

    await openViaPalette(page, 'By the setting')

    await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(2)
    await expect(modeSwitch(page, 'Page')).toHaveAttribute('aria-checked', 'true')

    await chooseInSettings(page, 'Blocks')
    await openViaPalette(page, 'By the setting')
    await expect(page.locator('[data-testid="block-static"]').first()).toBeVisible()
    await expect(page.locator(EDITOR)).toHaveCount(0)
  })

  test('the switch and Ctrl+Shift+M change only the page on screen', async ({ page }) => {
    await seedPage(page, 'Switched here', ['alpha'])
    await seedPage(page, 'Not switched', ['beta'])
    await openViaPalette(page, 'Switched here')
    // How the selected item looks, read off Blocks while it is the selected one.
    const selectedLook = await modeSwitch(page, 'Blocks').evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    )

    await page.keyboard.press('Control+Shift+M')
    await expect(page.locator(EDITOR)).toBeVisible()
    expect(await axeViolations(page, '[role="radiogroup"]')).toEqual([])
    await expect(modeSwitch(page, 'Page')).toHaveCSS('background-color', selectedLook)
    await expect(modeSwitch(page, 'Blocks')).not.toHaveCSS('background-color', selectedLook)

    await openViaPalette(page, 'Not switched')
    await expect(page.locator('[data-testid="block-static"]').first()).toBeVisible()
    await expect(modeSwitch(page, 'Blocks')).toHaveAttribute('aria-checked', 'true')

    await modeSwitch(page, 'Page').click()
    await expect(page.locator(EDITOR)).toBeVisible()
    await page.locator(EDITOR).click()
    await page.keyboard.press('Control+Shift+M')
    await expect(page.locator('[data-testid="block-editor"]')).toBeVisible()
  })

  test('a page holding a priority keeps block mode, the switch saying why, even with the setting on Page', async ({
    page,
  }) => {
    const [urgent] = await seedPage(page, 'Has a priority', ['do it', 'plain'])
    await page.evaluate(
      ({ id }) =>
        (window as unknown as MockWindow).__TAURI_INTERNALS__.invoke('set_priority', {
          blockId: id,
          level: '1',
        }),
      { id: urgent as string },
    )
    await chooseInSettings(page, 'Page')

    await openViaPalette(page, 'Has a priority')

    await expect(page.locator('[data-testid="block-static"]').first()).toBeVisible()
    await expect(page.locator(EDITOR)).toHaveCount(0)
    const pageRadio = modeSwitch(page, 'Page')
    await expect(pageRadio).toHaveAttribute('aria-disabled', 'true')
    await expect(pageRadio).toHaveAccessibleDescription('Page mode can’t show priorities yet.')
    await pageRadio.hover()
    await expect(page.getByRole('tooltip')).toHaveText('Page mode can’t show priorities yet.')
    expect(await axeViolations(page, '[role="radiogroup"]')).toEqual([])

    await page.keyboard.press('Control+Shift+M')
    await expect(page.getByText('Page mode can’t show priorities yet.').last()).toBeVisible()
    await expect(page.locator(EDITOR)).toHaveCount(0)
  })

  test('a page whose block holds a property: the switch finds out when pointed at, and says why', async ({
    page,
  }) => {
    const [block] = await seedPage(page, 'Has a property', ['alpha'])
    await page.evaluate(
      ({ id }) =>
        (window as unknown as MockWindow).__TAURI_INTERNALS__.invoke('set_property', {
          blockId: id,
          key: 'effort',
          value: {
            value_text: '1h',
            value_num: null,
            value_date: null,
            value_ref: null,
            value_bool: null,
          },
        }),
      { id: block as string },
    )
    await openViaPalette(page, 'Has a property')

    await modeSwitch(page, 'Page').hover()

    await expect(modeSwitch(page, 'Page')).toHaveAttribute('aria-disabled', 'true')
    await expect(page.getByRole('tooltip')).toHaveText('Page mode can’t show block properties yet.')
  })

  test('a page over the block cap keeps block mode, and the switch says why', async ({ page }) => {
    await seedPage(
      page,
      'Over the cap',
      Array.from({ length: 501 }, (_, i) => `block ${i}`),
    )
    await openViaPalette(page, 'Over the cap')

    await expect(modeSwitch(page, 'Page')).toHaveAttribute('aria-disabled', 'true')
    await expect(modeSwitch(page, 'Page')).toHaveAccessibleDescription(
      'Page mode opens pages of up to 500 blocks; this one has 501.',
    )
    await page.keyboard.press('Control+Shift+M')
    await expect(page.locator(EDITOR)).toHaveCount(0)
    await expect(page.locator('[data-testid="block-static"]').first()).toBeVisible()
  })
})

test.describe('on a phone (#5691)', () => {
  const iPhone13 = devices['iPhone 13']
  test.use({
    viewport: iPhone13.viewport,
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  test('neither the setting nor the switch is offered, and pages edit as blocks', async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem('agaric-edit-mode', 'page'))
    await waitForBoot(page)
    await seedPage(page, 'On a phone', ['alpha'])

    await openPageMobile(page, 'On a phone')

    await expect(page.locator('[data-testid="block-static"]').first()).toBeVisible()
    await expect(page.getByRole('radiogroup', { name: 'Editing mode' })).toHaveCount(0)
    await expect(page.locator(EDITOR)).toHaveCount(0)

    await navigateMobile(page, 'Settings')
    await openSettingsTab(page, 'Editor')
    await expect(page.getByTestId('emoji-picker-toggle')).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Edit pages as' })).toHaveCount(0)
  })
})
