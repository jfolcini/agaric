import type { Page } from '@playwright/test'

import {
  axeViolations,
  expect,
  focusBlockById,
  navigateToView,
  openPage,
  reopenPage,
  replaceEditorText,
  test,
  waitForBoot,
} from './helpers'

/**
 * Moving between blocks from the keyboard (#6537): a keyboard-only user starts
 * editing a block, Shift+Arrow at a block's edge turns into block selection, and
 * Arrow Up/Down leaves a block from its first or last visual line keeping the
 * caret's horizontal position. In `e2e/` because each needs real key presses,
 * real layout (visual lines, x coordinates) and DOM focus, none of which jsdom has.
 */

const PAGE = 'Getting Started'
// SEED_IDS.BLOCK_GS_1..4 in src/lib/tauri-mock/seed.ts
const GS1 = '0000000000000000000BLOCK01'
const GS2 = '0000000000000000000BLOCK02'
const GS3 = '0000000000000000000BLOCK03'
const GS4 = '0000000000000000000BLOCK04'

const liveEditor = (page: Page) =>
  page.locator('[data-testid="block-editor"] [contenteditable="true"]')
const staticBlock = (page: Page, id: string) =>
  page.locator(`[data-testid="block-static"][data-block-id="${id}"]`)
const selectBox = (page: Page, id: string) =>
  page.locator(`li[data-block-id="${id}"]`).getByRole('checkbox', { name: 'Select block' })

/** The block the roving editor is mounted on, or null. */
async function editingBlockId(page: Page): Promise<string | null> {
  const editor = page.locator('[data-testid="block-editor"]')
  if ((await editor.count()) === 0) return null
  return editor.getAttribute('data-block-id')
}

interface Caret {
  /** Characters of text before the caret in its textblock. */
  offset: number
  /** Whether the caret is at the end of the document. */
  atEnd: boolean
}

async function caret(page: Page): Promise<Caret> {
  return liveEditor(page).evaluate((el) => {
    const { editor } = el as HTMLElement & {
      editor: {
        state: {
          selection: { head: number; $head: { parentOffset: number } }
          doc: { content: { size: number } }
        }
      }
    }
    const { selection, doc } = editor.state
    return { offset: selection.$head.parentOffset, atEnd: selection.head >= doc.content.size - 1 }
  })
}

/** Put the caret at `offset` in the first textblock, past ProseMirror's post-focus sync. */
async function placeCaret(page: Page, offset: number): Promise<void> {
  await liveEditor(page).evaluate((el, at) => {
    const { editor } = el as HTMLElement & {
      editor: { commands: { setTextSelection: (pos: number) => boolean } }
    }
    editor.commands.setTextSelection(1 + at)
    return new Promise((resolve) => setTimeout(resolve, 20))
  }, offset)
}

/** Give each block of `texts` (by id) that text through its editor, then leave editing. */
async function setTexts(page: Page, texts: Record<string, string>): Promise<void> {
  for (const [id, text] of Object.entries(texts)) {
    await focusBlockById(page, id)
    await replaceEditorText(page, text)
  }
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(liveEditor(page)).toHaveCount(0)
}

test.describe('Starting to edit a block from the keyboard (#6537) @editor @journal', () => {
  test('from boot, Ctrl+ArrowDown then Enter edits the first block of the journal', async ({
    page,
  }) => {
    await waitForBoot(page)
    const first = page.locator('[data-testid="block-static"]').first()
    await expect(first).toBeVisible()
    const firstId = (await first.getAttribute('data-block-id')) as string
    const original = (await first.textContent()) ?? ''

    await page.keyboard.press('Control+ArrowDown')
    await expect(page.locator(`li[data-block-id="${firstId}"]`)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(liveEditor(page)).toBeFocused()
    expect(await editingBlockId(page)).toBe(firstId)
    await page.keyboard.type('Z')
    await expect(liveEditor(page)).toHaveText(`${original}Z`)
    await page.keyboard.press('Escape')
    await expect(staticBlock(page, firstId)).toHaveText(`${original}Z`)
  })

  test('in the week view, Ctrl+ArrowDown then Enter edits the first block of the week', async ({
    page,
  }) => {
    await waitForBoot(page)
    await page.getByRole('tab', { name: 'Weekly view' }).click()
    const first = page.locator('li[data-block-id]').first()
    await expect(first).toBeVisible()
    const firstId = (await first.getAttribute('data-block-id')) as string

    await page.keyboard.press('Control+ArrowDown')
    await expect(first).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(liveEditor(page)).toBeFocused()
    expect(await editingBlockId(page)).toBe(firstId)
  })

  test('with nothing selected, Ctrl+ArrowUp puts the cursor on the last block', async ({
    page,
  }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
    const last = page.locator('li[data-block-id]').last()
    await page.locator('body').click({ position: { x: 1, y: 1 } })
    await page.keyboard.press('Control+ArrowUp')
    await expect(last).toBeFocused()
  })
})

test.describe('Resuming editing after Escape (#6537) @editor', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
  })

  for (const key of ['Enter', 'F2'] as const) {
    test(`${key} on the selected row edits the same block with the caret at the end`, async ({
      page,
    }) => {
      await focusBlockById(page, GS3)
      const original = (await liveEditor(page).textContent()) ?? ''
      await placeCaret(page, 0)
      await page.keyboard.press('Escape')
      const row = page.locator(`li[data-block-id="${GS3}"]`)
      await expect(row).toBeFocused()
      expect(await axeViolations(page, `li[data-block-id="${GS3}"]`)).toEqual([])

      await page.keyboard.press(key)
      await expect(liveEditor(page)).toBeFocused()
      expect(await editingBlockId(page)).toBe(GS3)
      await page.keyboard.type('Q')
      await expect(liveEditor(page)).toHaveText(`${original}Q`)

      await reopenPage(page, PAGE)
      await expect(staticBlock(page, GS3)).toHaveText(`${original}Q`)
    })
  }
})

test.describe('Enter on a control in the selected row (#6537) @editor', () => {
  test('Enter on the chevron of the selected row collapses it, not edits it', async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
    await focusBlockById(page, GS4)
    await page.keyboard.press('Tab') // GS4 under GS3
    await focusBlockById(page, GS3)
    await page.keyboard.press('Escape')
    const row = page.locator(`li[data-block-id="${GS3}"]`)
    await expect(row).toBeFocused()

    const chevron = row.getByTestId('collapse-toggle')
    await chevron.focus()
    await page.keyboard.press('Enter')
    await expect(chevron).toHaveAttribute('data-collapsed', 'true')
    await expect(liveEditor(page)).toHaveCount(0)
  })
})

test.describe('Shift+Arrow at a block edge selects blocks (#6537) @editor', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
  })

  test('Shift+ArrowDown past the end of block 2 selects blocks 2 and 3 and saves block 2', async ({
    page,
  }) => {
    await focusBlockById(page, GS2)
    await placeCaret(page, 0)
    await page.keyboard.type('Typed ')
    // Shift+ArrowDown runs the text selection to the end of the block, one visual line a press.
    for (let i = 0; i < 5 && !(await caret(page)).atEnd; i++) {
      await page.keyboard.press('Shift+ArrowDown')
    }
    expect((await caret(page)).atEnd).toBe(true)
    expect(await editingBlockId(page)).toBe(GS2)

    await page.keyboard.press('Shift+ArrowDown')
    await expect(liveEditor(page)).toHaveCount(0)
    await expect(selectBox(page, GS2)).toBeChecked()
    await expect(selectBox(page, GS3)).toBeChecked()
    await expect(selectBox(page, GS1)).not.toBeChecked()
    await expect(selectBox(page, GS4)).not.toBeChecked()

    // The block selection carries on from there.
    await page.keyboard.press('Shift+ArrowDown')
    await expect(selectBox(page, GS4)).toBeChecked()

    await reopenPage(page, PAGE)
    await expect(staticBlock(page, GS2)).toContainText('Typed Use the sidebar')
  })

  test('Shift+ArrowUp past the start of block 3 selects blocks 3 and 2', async ({ page }) => {
    await focusBlockById(page, GS3)
    await placeCaret(page, 0)
    await page.keyboard.press('Shift+ArrowUp')
    await expect(liveEditor(page)).toHaveCount(0)
    await expect(selectBox(page, GS3)).toBeChecked()
    await expect(selectBox(page, GS2)).toBeChecked()
    await expect(selectBox(page, GS4)).not.toBeChecked()
  })
})

test.describe('Arrow Up/Down between blocks keeps the column (#6537) @editor @journal', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
  })

  // The same leading words in each block put column 10 at the same x in all three, so the
  // landing column is exact up to rounding at a glyph's middle: ±1 for proportional fonts.
  const TEXTS = {
    [GS1]: 'The quick brown fox one',
    [GS2]: 'The quick brown fox two',
    [GS3]: 'The quick brown fox three',
  }

  test('one ArrowUp and one ArrowDown move a block each and keep column 10', async ({ page }) => {
    await setTexts(page, TEXTS)
    await focusBlockById(page, GS2)
    await placeCaret(page, 10)

    await page.keyboard.press('ArrowUp')
    await expect.poll(() => editingBlockId(page)).toBe(GS1)
    await expect(liveEditor(page)).toBeFocused()
    const up = await caret(page)
    expect(Math.abs(up.offset - 10)).toBeLessThanOrEqual(1)

    await page.keyboard.press('ArrowDown')
    await expect.poll(() => editingBlockId(page)).toBe(GS2)
    const down = await caret(page)
    expect(Math.abs(down.offset - 10)).toBeLessThanOrEqual(1)

    await page.keyboard.type('M')
    const text = (await liveEditor(page).textContent()) ?? ''
    expect(Math.abs(text.indexOf('M') - 10)).toBeLessThanOrEqual(1)
    expect(text.replace('M', '')).toBe(TEXTS[GS2])

    await page.keyboard.press('ArrowDown')
    await expect.poll(() => editingBlockId(page)).toBe(GS3)
    expect(Math.abs((await caret(page)).offset - 10)).toBeLessThanOrEqual(2)
  })

  test('in the journal, one ArrowDown keeps column 10', async ({ page }) => {
    await navigateToView(page, 'Journal')
    const ids = await page
      .locator('[data-testid="block-static"]')
      .evaluateAll((els) => els.slice(0, 2).map((el) => el.getAttribute('data-block-id') ?? ''))
    const [top, below] = ids as [string, string]
    await setTexts(page, { [top]: TEXTS[GS1], [below]: TEXTS[GS2] })
    await focusBlockById(page, top)
    await placeCaret(page, 10)

    await page.keyboard.press('ArrowDown')
    await expect.poll(() => editingBlockId(page)).toBe(below)
    expect(Math.abs((await caret(page)).offset - 10)).toBeLessThanOrEqual(1)
  })

  test('ArrowUp from the second visual line of a wrapped block stays in the block', async ({
    page,
  }) => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
    await setTexts(page, { [GS2]: long })
    await focusBlockById(page, GS2)
    const lineHeights = await liveEditor(page).evaluate((el) => {
      const p = el.querySelector('p') as HTMLElement
      return p.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(p).lineHeight)
    })
    expect(lineHeights).toBeGreaterThan(1.5)
    await placeCaret(page, long.length)

    await page.keyboard.press('ArrowUp')
    expect(await editingBlockId(page)).toBe(GS2)
    const after = await caret(page)
    expect(after.offset).toBeLessThan(long.length)
    expect(after.offset).toBeGreaterThan(0)
  })
})
