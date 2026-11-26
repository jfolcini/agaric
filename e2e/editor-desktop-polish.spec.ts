/**
 * #7040 D3 — the page editor on a desktop window: the editing box holds a
 * task's whole row, the link kinds share one look, a range selection draws no
 * Markdown markers (decision 19), and the selection bubble opens above the
 * selection, clear of the block below.
 */

import type { Locator, Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  expect,
  focusBlockById,
  ipc,
  openPage,
  selectEditorRange,
  test,
  waitForBoot,
} from './helpers'

test.use({ viewport: { width: 1440, height: 900 } })

const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'
const PAGE_EDITOR = '[data-testid="page-mode-editor"]'

/** Select characters `from` to `to` of page mode's block `index` and focus the page. */
async function selectInPageBlock(page: Page, index: number, from: number, to: number) {
  await page.evaluate(
    ({ selector, index: i, from: f, to: t }) => {
      const { editor } = document.querySelector(selector) as HTMLElement & {
        editor: {
          state: { doc: { child: (n: number) => { nodeSize: number } } }
          commands: { setTextSelection: (range: { from: number; to: number }) => boolean }
          view: { focus: () => void }
        }
      }
      let pos = 0
      for (let k = 0; k < i; k += 1) pos += editor.state.doc.child(k).nodeSize
      editor.view.focus()
      editor.commands.setTextSelection({ from: pos + 2 + f, to: pos + 2 + t })
    },
    { selector: PAGE_EDITOR, index, from, to },
  )
}

interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

async function box(locator: Locator): Promise<Box> {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
  })
}

/** The box of the window's selection. */
function selectionBox(page: Page): Promise<Box> {
  return page.evaluate(() => {
    const r = window.getSelection()?.getRangeAt(0).getBoundingClientRect()
    if (!r) throw new Error('nothing is selected')
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
  })
}

/** The box drawn around the block being edited: the nearest of the editor's ancestors with a ring. */
async function editingBox(page: Page): Promise<Box> {
  return page.locator(EDITOR).evaluate((editor) => {
    for (let el = editor.parentElement; el; el = el.parentElement) {
      if (getComputedStyle(el).boxShadow !== 'none') {
        const r = el.getBoundingClientRect()
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
      }
    }
    throw new Error('no box is drawn around the editor')
  })
}

function contains(outer: Box, inner: Box): boolean {
  return (
    outer.left <= inner.left &&
    outer.top <= inner.top &&
    outer.right >= inner.right &&
    outer.bottom >= inner.bottom
  )
}

async function expectBoxHoldsTaskRow(page: Page, blockId: string): Promise<void> {
  await focusBlockById(page, blockId)
  const row = page.locator('[data-testid="swipe-content"]').filter({ has: page.locator(EDITOR) })
  const checkbox = await box(row.getByTestId('task-marker'))
  const chips = await box(row.getByTestId('block-metadata-row'))
  const editing = await editingBox(page)
  expect(contains(editing, checkbox), 'the editing box holds the checkbox').toBe(true)
  expect(contains(editing, chips), 'the editing box holds the chips').toBe(true)
}

test.describe('editor on a desktop window (#7040 D3) @editor @journal @markdown @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('the editing box holds a task’s checkbox, text and chips, on a page and a journal day @editor @journal @pages', async ({
    page,
  }) => {
    await expectBoxHoldsTaskRow(page, SEED_IDS.BLOCK_DAILY_3)
    await openPage(page, 'Projects')
    await expectBoxHoldsTaskRow(page, SEED_IDS.BLOCK_PROJ_1)
  })

  test('a row edited inside an unlocked embed has the editing box too @editor', async ({
    page,
  }) => {
    await ipc(page, 'edit_block', {
      blockId: SEED_IDS.BLOCK_QN_1,
      toText: `{{embed ((${SEED_IDS.BLOCK_GS_1}))}}`,
    })
    await openPage(page, 'Quick Notes')
    const embed = page.getByTestId('embed-container')
    await embed.getByRole('button', { name: 'Edit this embed in place' }).click()
    await embed.getByText('Welcome to Agaric!', { exact: false }).click()
    const editing = await editingBox(page)
    expect(contains(await box(embed), editing), 'the box is the row’s, inside the embed').toBe(true)
  })

  test('a page link and a URL share the link colour and underline, set apart from plain text @editor @pages', async ({
    page,
  }) => {
    await ipc(page, 'edit_block', {
      blockId: SEED_IDS.BLOCK_GS_2,
      toText: `Read [[${SEED_IDS.PAGE_PROJECTS}]] and [the docs](https://example.com) today`,
    })
    await openPage(page, 'Getting Started')
    const style = (el: Locator) =>
      el.evaluate((node) => {
        const s = getComputedStyle(node)
        return {
          color: s.color,
          line: s.textDecorationLine,
          decoration: s.textDecorationColor,
          weight: s.fontWeight,
        }
      })
    const check = async (scope: Locator) => {
      const pageLink = await style(scope.locator('.block-link-chip'))
      const url = await style(scope.locator('.external-link'))
      const text = await style(scope)
      expect(url, 'a URL looks like a page link').toEqual(pageLink)
      expect(pageLink.line).toBe('underline')
      expect(pageLink.color, 'a link is not the colour of the text around it').not.toBe(text.color)
      expect(pageLink.weight, 'a link keeps the weight of the text around it').toBe(text.weight)
    }
    const block = page.locator(
      `[data-testid="block-static"][data-block-id="${SEED_IDS.BLOCK_GS_2}"]`,
    )
    await check(block)
    await focusBlockById(page, SEED_IDS.BLOCK_GS_2)
    await check(page.locator(EDITOR))
  })

  test('a range selection, by Shift or a drag, draws no markers and moves no text; a caret still does @editor @markdown', async ({
    page,
  }) => {
    await ipc(page, 'edit_block', {
      blockId: SEED_IDS.BLOCK_GS_2,
      toText: 'Plain words then **bold words here** and more plain words after it',
    })
    await openPage(page, 'Getting Started')
    await focusBlockById(page, SEED_IDS.BLOCK_GS_2)
    const markers = page.getByTestId('md-reveal-marker')
    const bold = page.locator(EDITOR).locator('strong')

    // `Plain words then bo|ld`: a caret in the bold text draws its markers.
    await selectEditorRange(page, 19, 19)
    await expect(markers).toHaveText(['**', '**'])

    // A caret in plain text, then Shift+Arrow into the bold text.
    await selectEditorRange(page, 2, 2)
    await expect(markers).toHaveCount(0)
    const still = await box(bold)
    for (let i = 0; i < 25; i++) await page.keyboard.press('Shift+ArrowRight')
    await expect(page.getByTestId('selection-bubble-menu')).toBeVisible()
    await expect(markers).toHaveCount(0)
    expect(await box(bold)).toEqual(still)

    // A drag from the plain text into the bold text.
    await selectEditorRange(page, 2, 2)
    await expect(markers).toHaveCount(0)
    const start = await box(page.locator(EDITOR))
    await page.mouse.move(start.left + 4, (still.top + still.bottom) / 2)
    await page.mouse.down()
    await page.mouse.move((still.left + still.right) / 2, (still.top + still.bottom) / 2, {
      steps: 5,
    })
    await page.mouse.up()
    await expect(page.getByTestId('selection-bubble-menu')).toBeVisible()
    await expect(markers).toHaveCount(0)
    expect(await box(bold)).toEqual(still)
  })

  test('the selection bubble opens above the selection, clear of the next block, and below it only under the toolbar @editor', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    const bubble = page.getByTestId('selection-bubble-menu')

    await focusBlockById(page, SEED_IDS.BLOCK_GS_3)
    await selectEditorRange(page, 0, 6)
    await expect(bubble).toBeVisible()
    const placed = await box(bubble)
    const next = await box(
      page.locator(`[data-testid="block-static"][data-block-id="${SEED_IDS.BLOCK_GS_4}"]`),
    )
    expect(placed.bottom, 'the bubble sits above the selection').toBeLessThanOrEqual(
      (await selectionBox(page)).top,
    )
    expect(placed.bottom, 'the bubble leaves the next block in view').toBeLessThanOrEqual(next.top)

    // The first line sits just under the toolbar, which would cover a bubble above it.
    await focusBlockById(page, SEED_IDS.BLOCK_GS_1)
    await selectEditorRange(page, 0, 7)
    await expect(bubble).toBeVisible()
    const toolbar = await box(page.locator('[data-view-toolbar] .formatting-toolbar'))
    const flipped = await box(bubble)
    expect(flipped.top, 'the bubble clears the toolbar').toBeGreaterThanOrEqual(toolbar.bottom)
    expect(flipped.top, 'the bubble sits below the selection').toBeGreaterThanOrEqual(
      (await selectionBox(page)).bottom,
    )
  })

  test('page mode’s selection bubble opens above the selection, and below it only under its toolbar @editor @pages', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    await page
      .getByRole('radiogroup', { name: 'Editing mode' })
      .getByRole('radio', { name: 'Page' })
      .click()
    const blocks = page.locator(`${PAGE_EDITOR} [data-page-block]`)
    await expect(blocks).toHaveCount(5)
    const bubble = page.getByTestId('selection-bubble-menu')

    await selectInPageBlock(page, 2, 0, 6)
    await expect(bubble).toBeVisible()
    const placed = await box(bubble)
    expect(placed.bottom, 'the bubble sits above the selection').toBeLessThanOrEqual(
      (await selectionBox(page)).top,
    )
    expect(placed.bottom, 'the bubble leaves the next block in view').toBeLessThanOrEqual(
      (await box(blocks.nth(3))).top,
    )

    // Scroll block 2 up to just under the sticky toolbar, which would cover a bubble above it.
    await page.setViewportSize({ width: 1440, height: 400 })
    await blocks.nth(2).evaluate((block) => {
      const bar = document.querySelector('.formatting-toolbar')?.getBoundingClientRect()
      if (!bar) throw new Error('page mode shows no toolbar')
      let scroller = block.parentElement
      while (scroller && scroller.scrollHeight <= scroller.clientHeight) {
        scroller = scroller.parentElement
      }
      if (!scroller) throw new Error('nothing scrolls the page')
      scroller.scrollTop += block.getBoundingClientRect().top - bar.bottom - 2
      // The toolbar sticks only once the page scrolls: measure it again where it stuck.
      const stuck = document.querySelector('.formatting-toolbar')?.getBoundingClientRect()
      scroller.scrollTop += block.getBoundingClientRect().top - (stuck?.bottom ?? 0) - 2
    })
    const toolbar = await box(page.locator('.formatting-toolbar'))
    expect((await box(blocks.nth(2))).top - toolbar.bottom).toBeLessThan(8)
    // Another range: the same one again is no change, and the bubble would not be placed anew.
    await selectInPageBlock(page, 2, 1, 5)
    // Still shown from the first selection: it is placed anew a moment later.
    const below = (await selectionBox(page)).bottom
    await expect
      .poll(async () => (await box(bubble)).top, { message: 'the bubble sits below the selection' })
      .toBeGreaterThanOrEqual(below)
    expect((await box(bubble)).top, 'the bubble clears the toolbar').toBeGreaterThanOrEqual(
      toolbar.bottom,
    )
  })
})
