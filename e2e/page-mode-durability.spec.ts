/**
 * Page mode keeps what is typed (#5691), against the mock backend: typing that
 * never pauses is saved while it goes on, the window hidden or closing saves at
 * once, a save the backend refuses says so and keeps the text for the next one,
 * redo in the document and of the page, an agent's write shown in place and
 * undone first, and a search hit opening its page in page mode with the cursor
 * in the hit.
 */

import {
  blurEditors,
  emitMockEvent,
  expect,
  ipc,
  navigateToView,
  openSettingsTab,
  reopenPage,
  submitSearch,
  test,
  waitForBoot,
} from './helpers'
import {
  PAGE_EDITOR,
  type SeededPage,
  backendTexts,
  caret,
  cursor,
  modeSwitch,
  openInPageMode,
  openPageByTitle,
  seedPage,
  shownBlocks,
} from './page-mode'

const TITLE = 'Page mode durability'
const SAVE_FAILED = /could not be saved yet/

interface MockErrors {
  __injectMockError: (command: string, error: string) => void
  __clearMockErrors: () => void
}

test.describe('page mode keeps what is typed (#5691) @editor @pages', () => {
  let seeded: SeededPage

  test.beforeEach(async ({ page }) => {
    // Installed before boot, so a test can stop the clock under the save's timers.
    await page.clock.install()
    await waitForBoot(page)
    seeded = await seedPage(page, TITLE, [
      [0, 'alpha'],
      [0, 'beta'],
      [0, 'gamma'],
    ])
    await openInPageMode(page, TITLE, 3)
  })

  test('typing that never pauses is saved while it goes on', async ({ page }) => {
    await caret(page, 0, 'end')
    await page.clock.pauseAt(Date.now() + 60_000)

    // A key every 500 ms: the save's pause (700 ms) never comes.
    for (const key of ' typing on') {
      await page.keyboard.type(key)
      await page.clock.runFor(500)
    }
    await page.keyboard.type('!')

    await expect
      .poll(async () => (await backendTexts(page, seeded.pageId))[0])
      .toBe('alpha typing on')
    expect((await shownBlocks(page))[0]?.text).toBe('alpha typing on!')
  })

  for (const [name, hide] of [
    [
      'hidden',
      () => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
      },
    ],
    ['closing', () => void window.dispatchEvent(new Event('pagehide'))],
  ] as const) {
    test(`the window ${name} saves the text typed just before, with no pause`, async ({ page }) => {
      await caret(page, 1, 'end')
      await page.clock.pauseAt(Date.now() + 60_000)
      await page.keyboard.type(' unsaved')
      expect((await backendTexts(page, seeded.pageId))[1]).toBe('beta')

      await page.evaluate(hide)

      await expect
        .poll(async () => (await backendTexts(page, seeded.pageId))[1])
        .toBe('beta unsaved')
      // The caret never left: the save was the window's, not a blur's.
      await expect(page.locator(PAGE_EDITOR)).toBeFocused()
    })
  }

  test('a save the backend refuses says so, keeps the text and the mode, and the next save writes it', async ({
    page,
  }) => {
    await page.evaluate(() =>
      (window as unknown as MockErrors).__injectMockError('edit_block', 'disk full'),
    )
    await caret(page, 2, 'end')
    await page.keyboard.type(' kept')

    await expect(page.getByText(SAVE_FAILED)).toBeVisible()
    expect((await backendTexts(page, seeded.pageId))[2]).toBe('gamma')

    // A switch whose save fails stays in page mode, the text still there.
    await modeSwitch(page, 'Blocks').click()
    await expect(page.getByText(SAVE_FAILED)).toBeVisible()
    await expect(modeSwitch(page, 'Page')).toHaveAttribute('aria-checked', 'true')
    expect((await shownBlocks(page))[2]?.text).toBe('gamma kept')

    await page.evaluate(() => (window as unknown as MockErrors).__clearMockErrors())
    await modeSwitch(page, 'Blocks').click()

    await expect(modeSwitch(page, 'Blocks')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByText('gamma kept', { exact: true })).toBeVisible()
    expect(await backendTexts(page, seeded.pageId)).toEqual(['alpha', 'beta', 'gamma kept'])
  })

  test('Ctrl+Z takes typed text back and Ctrl+Y and Ctrl+Shift+Z put it back, each saved', async ({
    page,
  }) => {
    await caret(page, 0, 'end')
    await page.keyboard.type(' one')
    await expect.poll(async () => (await backendTexts(page, seeded.pageId))[0]).toBe('alpha one')

    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await backendTexts(page, seeded.pageId))[0]).toBe('alpha')
    await page.keyboard.press('Control+y')
    await expect.poll(async () => (await backendTexts(page, seeded.pageId))[0]).toBe('alpha one')

    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await backendTexts(page, seeded.pageId))[0]).toBe('alpha')
    await page.keyboard.press('Control+Shift+Z')
    await expect.poll(async () => (await backendTexts(page, seeded.pageId))[0]).toBe('alpha one')
    expect((await shownBlocks(page))[0]?.text).toBe('alpha one')
  })

  test('the page’s undo and redo, run from outside the text, show in the document and stay', async ({
    page,
  }) => {
    await caret(page, 1, 'end')
    await page.keyboard.type(' two')
    await expect.poll(async () => (await backendTexts(page, seeded.pageId))[1]).toBe('beta two')

    await blurEditors(page)
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await shownBlocks(page))[1]?.text).toBe('beta')
    expect((await backendTexts(page, seeded.pageId))[1]).toBe('beta')

    await page.keyboard.press('Control+y')
    await expect.poll(async () => (await shownBlocks(page))[1]?.text).toBe('beta two')
    expect((await backendTexts(page, seeded.pageId))[1]).toBe('beta two')

    await reopenPage(page, TITLE)
    await expect(page.getByText('beta two', { exact: true })).toBeVisible()
  })

  test('an agent’s write shows in place, and the page’s Ctrl+Z takes it off before the edit typed here', async ({
    page,
  }) => {
    await caret(page, 0, 'end')
    await page.keyboard.type(' typed')
    await expect.poll(async () => (await backendTexts(page, seeded.pageId))[0]).toBe('alpha typed')
    await blurEditors(page)
    // Edits closer than the undo group window join one entry.
    await page.clock.fastForward(1000)

    await ipc(page, 'edit_block', { blockId: seeded.ids[2], toText: 'gamma, from an agent' })
    await emitMockEvent(page, 'blocks:changed', { changed_page_ids: [seeded.pageId] })
    await expect
      .poll(async () => (await shownBlocks(page)).map((b) => b.text))
      .toEqual(['alpha typed', 'beta', 'gamma, from an agent'])

    await page.keyboard.press('Control+z')
    await expect
      .poll(async () => (await shownBlocks(page)).map((b) => b.text))
      .toEqual(['alpha typed', 'beta', 'gamma'])
    expect(await backendTexts(page, seeded.pageId)).toEqual(['alpha typed', 'beta', 'gamma'])

    await page.keyboard.press('Control+z')
    await expect
      .poll(async () => (await shownBlocks(page)).map((b) => b.text))
      .toEqual(['alpha', 'beta', 'gamma'])
    expect(await backendTexts(page, seeded.pageId)).toEqual(['alpha', 'beta', 'gamma'])
  })
})

test.describe('a search hit on a page that opens in page mode (#5691) @editor @pages @search', () => {
  test('lands the cursor in the hit’s block, where typing then goes and is saved', async ({
    page,
  }) => {
    await waitForBoot(page)
    const seeded = await seedPage(page, 'Hit in page mode', [
      [0, 'first line'],
      [0, 'the needleword is here'],
      [0, 'last line'],
    ])
    await navigateToView(page, 'Settings')
    await openSettingsTab(page, 'Editor')
    await page.getByRole('combobox', { name: 'Edit pages as' }).click()
    await page.getByRole('option', { name: 'Page', exact: true }).click()

    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Search', exact: true })
      .click()
    await submitSearch(page, 'needleword')
    await page.getByTestId(`search-result-row-${seeded.ids[1]}`).click()

    await expect(page.locator(`${PAGE_EDITOR} [data-page-block]`)).toHaveCount(3)
    await expect(page.locator(PAGE_EDITOR)).toBeFocused()
    expect(await cursor(page)).toEqual({ index: 1, offset: 0 })

    await page.keyboard.type('found: ')
    const typed = 'found: the needleword is here'
    await expect.poll(async () => (await backendTexts(page, seeded.pageId))[1]).toBe(typed)

    await openPageByTitle(page, 'Getting Started')
    await openPageByTitle(page, 'Hit in page mode')
    await expect.poll(async () => (await shownBlocks(page))[1]?.text).toBe(typed)
  })
})
