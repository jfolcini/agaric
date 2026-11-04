/**
 * *Read aloud* (#5745) on the mock, standing in for macOS / Windows: `speech_status` answers
 * `Webview` (`localStorage['__mockSpeechStatus']`) and an init script replaces the webview's
 * `speechSynthesis` with a fake that records each utterance and speaks nothing, so the spec ends
 * each one itself (`finishUtterance`). Real voices are a device check: CI's Chromium has none.
 */
import type { Locator, Page } from '@playwright/test'

import {
  activeMenu,
  expect,
  focusBlock,
  navigateToView,
  openPage,
  selectEditorRange,
  test,
  waitForBoot,
} from './helpers'

const PAGE = 'Getting Started'
const GS_1 = 'Welcome to Agaric! This is your personal knowledge base.'
const GS_2 =
  'Use the sidebar to navigate between pages, tags, and search. See Quick Notes for tips.'
const GS_3 = 'Create new blocks by pressing Enter at the end of any block.'

interface FakeSpeechWindow {
  __speech: { spoken: string[]; cancels: number; finish: () => void }
}

/** Installs the fake engine before boot; `status` is what `speech_status` answers. */
async function installFakeSpeech(page: Page, status: 'Webview' | 'Unsupported'): Promise<void> {
  await page.addInitScript((speechStatus) => {
    localStorage.setItem('__mockSpeechStatus', speechStatus)
    class FakeUtterance extends EventTarget {
      text: string
      constructor(text: string) {
        super()
        this.text = text
      }
    }
    let current: FakeUtterance | null = null
    const record = { spoken: [] as string[], cancels: 0, finish: () => {} }
    // A real engine reports the utterance `cancel()` cuts as interrupted.
    const synth = Object.assign(new EventTarget(), {
      speak: (utterance: FakeUtterance) => {
        record.spoken.push(utterance.text)
        current = utterance
      },
      cancel: () => {
        record.cancels += 1
        const cut = current
        current = null
        cut?.dispatchEvent(Object.assign(new Event('error'), { error: 'interrupted' }))
      },
      getVoices: () => [{ name: 'Fake voice' }],
    })
    record.finish = () => {
      const done = current
      current = null
      done?.dispatchEvent(new Event('end'))
    }
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true })
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      value: FakeUtterance,
      configurable: true,
    })
    ;(window as unknown as FakeSpeechWindow).__speech = record
  }, status)
}

function spoken(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as FakeSpeechWindow).__speech.spoken)
}

function cancels(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as FakeSpeechWindow).__speech.cancels)
}

async function finishUtterance(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as FakeSpeechWindow).__speech.finish())
}

function row(page: Page, blockId: string): Locator {
  return page.locator(`[data-testid="sortable-block"][data-block-id="${blockId}"]`)
}

/** The ids of the rows marked as being read. */
function readingRows(page: Page): Locator {
  return page.locator('[data-testid="sortable-block"][data-reading]')
}

function readingToast(page: Page): Locator {
  return page.locator('[data-sonner-toast]').filter({ hasText: 'Reading aloud…' })
}

async function blockIds(page: Page): Promise<string[]> {
  const ids = await page
    .locator('[data-testid="sortable-block"]')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-block-id') ?? ''))
  expect(ids.length).toBeGreaterThan(3)
  return ids
}

async function readBlockAloud(page: Page, blockId: string): Promise<void> {
  await page
    .locator(`[data-testid="block-static"][data-block-id="${blockId}"]`)
    .click({ button: 'right' })
  await activeMenu(page).getByRole('menuitem', { name: 'Read aloud' }).click()
}

/** Runs palette command `id` from the command palette (`Ctrl+P`, which the editor lets through). */
async function runPaletteCommand(page: Page, id: string): Promise<void> {
  await page.keyboard.press('Control+p')
  await expect(page.getByTestId('palette-mode-chip')).toHaveText('Commands')
  await page.getByTestId(`palette-cmd-${id}`).click()
}

test.describe('Read aloud @attachments @editor @pages @search', () => {
  test.beforeEach(async ({ page }) => {
    await installFakeSpeech(page, 'Webview')
    await waitForBoot(page)
    await openPage(page, PAGE)
  })

  test('reads a block with its child in order, marking the block being spoken', async ({
    page,
  }) => {
    const [, gs2, gs3, gs4] = await blockIds(page)
    // GS_3 becomes GS_2's child.
    await focusBlock(page, 2)
    await page.keyboard.press('Tab')
    await page.keyboard.press('Escape')
    await expect(row(page, gs3 as string)).toHaveAttribute('style', /padding-left/)

    await readBlockAloud(page, gs2 as string)
    await expect.poll(() => spoken(page)).toEqual([GS_2])
    await expect(readingRows(page)).toHaveCount(1)
    await expect(row(page, gs2 as string)).toHaveAttribute('data-reading', '')
    await expect(readingToast(page)).toBeVisible()

    await finishUtterance(page)
    await expect.poll(() => spoken(page)).toEqual([GS_2, GS_3])
    await expect(row(page, gs3 as string)).toHaveAttribute('data-reading', '')
    await expect(readingRows(page)).toHaveCount(1)

    // The sibling after the subtree is not read.
    await finishUtterance(page)
    await expect(readingRows(page)).toHaveCount(0)
    await expect(readingToast(page)).toBeHidden()
    expect(await spoken(page)).toEqual([GS_2, GS_3])
    await expect(row(page, gs4 as string)).not.toHaveAttribute('data-reading')
  })

  test('Stop on the toast ends the reading', async ({ page }) => {
    const [gs1] = await blockIds(page)
    await readBlockAloud(page, gs1 as string)
    await expect(row(page, gs1 as string)).toHaveAttribute('data-reading', '')

    await readingToast(page).getByRole('button', { name: 'Stop' }).click()
    await expect(readingRows(page)).toHaveCount(0)
    await expect(readingToast(page)).toBeHidden()
    expect(await cancels(page)).toBe(1)
    // The utterance `cancel()` cut reports `interrupted`, which is no engine failure.
    await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0)
  })

  test('closing the toast ends the reading', async ({ page }) => {
    const [gs1] = await blockIds(page)
    await readBlockAloud(page, gs1 as string)
    await expect(row(page, gs1 as string)).toHaveAttribute('data-reading', '')

    await readingToast(page).locator('[data-close-button]').click()
    await expect(readingRows(page)).toHaveCount(0)
    expect(await cancels(page)).toBe(1)
  })

  test('a reading started during another one keeps its toast and reads on', async ({ page }) => {
    const [gs1] = await blockIds(page)
    await readBlockAloud(page, gs1 as string)
    await expect.poll(() => spoken(page)).toEqual([GS_1])
    const firstToast = await readingToast(page).elementHandle()

    await runPaletteCommand(page, 'read-page-aloud')
    await expect.poll(() => spoken(page)).toEqual([GS_1, PAGE])
    // The first reading's toast animates out while the second's mounts; count once it has left.
    await expect.poll(() => firstToast?.evaluate((el) => el.isConnected)).toBe(false)
    await expect(readingToast(page)).toHaveCount(1)
    await expect(readingToast(page)).toBeVisible()
    await finishUtterance(page)
    await expect.poll(() => spoken(page)).toEqual([GS_1, PAGE, GS_1])
    await expect(row(page, gs1 as string)).toHaveAttribute('data-reading', '')
    await expect(readingToast(page)).toBeVisible()
  })

  test('navigating away ends the reading', async ({ page }) => {
    await runPaletteCommand(page, 'read-page-aloud')
    await expect.poll(() => spoken(page)).toEqual([PAGE])
    await finishUtterance(page)
    await expect.poll(() => spoken(page)).toEqual([PAGE, GS_1])

    await navigateToView(page, 'Pages')
    await expect.poll(() => cancels(page)).toBe(1)
    await expect(readingToast(page)).toBeHidden()
    await finishUtterance(page)
    expect(await spoken(page)).toEqual([PAGE, GS_1])

    await openPage(page, PAGE)
    await expect(page.locator('[data-testid="sortable-block"]').first()).toBeVisible()
    await expect(readingRows(page)).toHaveCount(0)
  })

  test('reads the text selected in the block being edited', async ({ page }) => {
    const [gs1] = await blockIds(page)
    const editor = await focusBlock(page, 0)
    await selectEditorRange(page, 0, 'Welcome to Agaric!'.length)
    // On the selected words, which a secondary click leaves selected.
    await editor.click({ button: 'right', position: { x: 10, y: 8 } })
    await activeMenu(page).getByRole('menuitem', { name: 'Read selection aloud' }).click()
    await expect.poll(() => spoken(page)).toEqual(['Welcome to Agaric!'])
    await expect(row(page, gs1 as string)).toHaveAttribute('data-reading', '')
  })
})

test.describe('Read aloud without an engine @attachments @editor @pages @search', () => {
  test('is offered nowhere', async ({ page }) => {
    await installFakeSpeech(page, 'Unsupported')
    await waitForBoot(page)
    await openPage(page, PAGE)
    const [gs1] = await blockIds(page)
    await page
      .locator(`[data-testid="block-static"][data-block-id="${gs1}"]`)
      .click({ button: 'right' })
    await expect(activeMenu(page).getByRole('menuitem', { name: /Delete/ })).toBeVisible()
    await expect(activeMenu(page).getByRole('menuitem', { name: 'Read aloud' })).toHaveCount(0)
    await page.keyboard.press('Escape')

    await page.keyboard.press('Control+p')
    await expect(page.getByTestId('palette-cmd-go-journal')).toBeVisible()
    await expect(page.getByTestId('palette-cmd-read-page-aloud')).toHaveCount(0)
  })
})
