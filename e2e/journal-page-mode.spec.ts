/**
 * The journal's daily view in page mode (#5691) against the mock backend: with
 * *Edit pages as* on Page, today's seeded day opens as one document, and what is
 * typed there is saved and shows again after leaving the journal; `Ctrl+E`
 * switches the day between blocks and page mode, keeping the caret's block and
 * the block at the top of the view, either way.
 */

import type { Page } from '@playwright/test'

import {
  expect,
  focusBlockById,
  ipc,
  navigateToView,
  selectEditorRange,
  test,
  waitForBoot,
} from './helpers'

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
/** Today's seeded daily page and its five blocks (`SEED_IDS` in `src/lib/tauri-mock/seed.ts`). */
const TODAY_PAGE = '00000000000000000000PAGE03'
const SEEDED_BLOCKS = 5
const DAY = '.journal-day-page'
const EDITOR = `${DAY} [data-testid="page-mode-editor"]`
const ROVING = '[data-testid="block-editor"] [contenteditable="true"]'

interface Place {
  id: string
  top: number
}

/** Run in the page: the day's block at the top of the view, either mode's, and how far below the scroller's top it starts. */
function placeShown(): Place | null {
  const at = (document.getElementById('main-content') as HTMLElement).getBoundingClientRect().top
  const rows = document.querySelectorAll(
    '.journal-day-page [data-page-block-id], .journal-day-page li[data-block-id]',
  )
  for (const row of rows) {
    const box = row.getBoundingClientRect()
    if (box.bottom > at) {
      const id = row.getAttribute('data-page-block-id') ?? row.getAttribute('data-block-id')
      return { id: id ?? '', top: Math.round(box.top - at) }
    }
  }
  return null
}

function topBlock(page: Page): Promise<Place | null> {
  return page.evaluate(placeShown)
}

/** The day's blocks' text as the backend holds them, in order. */
async function backendTexts(page: Page): Promise<string[]> {
  const { blocks } = await ipc<{
    blocks: Array<{ parent_id: string; position: number; content: string | null }>
  }>(page, 'load_page_subtree', { rootBlockId: TODAY_PAGE, scope: SCOPE })
  return blocks
    .filter((b) => b.parent_id === TODAY_PAGE)
    .toSorted((x, y) => x.position - y.position)
    .map((b) => b.content ?? '')
}

/** Put page mode's cursor `offset` characters into block `index`'s text, and focus the document. */
async function caret(page: Page, index: number, offset: number): Promise<void> {
  await page.evaluate(
    ({ selector, index: i, offset: o }) => {
      const { editor } = document.querySelector(selector) as HTMLElement & {
        editor: {
          state: { doc: { child: (n: number) => { nodeSize: number } } }
          commands: { setTextSelection: (pos: number) => boolean }
          view: { focus: () => void }
        }
      }
      let pos = 0
      for (let k = 0; k < i; k += 1) pos += editor.state.doc.child(k).nodeSize
      editor.commands.setTextSelection(pos + 2 + o)
      editor.view.focus()
      // After ProseMirror's own 20 ms selection write-back on focus (`page-mode.spec.ts`).
      return new Promise((resolve) => setTimeout(resolve, 20))
    },
    { selector: EDITOR, index, offset },
  )
  await expect(page.locator(EDITOR)).toBeFocused()
}

/** Page mode's cursor: the block it is in, and how far into its text. */
function cursor(page: Page): Promise<{ index: number; offset: number }> {
  return page.evaluate((selector) => {
    const { editor } = document.querySelector(selector) as HTMLElement & {
      editor: {
        state: { selection: { $from: { index: (d: number) => number; parentOffset: number } } }
      }
    }
    const { $from } = editor.state.selection
    return { index: $from.index(0), offset: $from.parentOffset }
  }, EDITOR)
}

/** Leave the journal for the Pages view and come back: the day's page is read again. */
async function leaveAndReturn(page: Page): Promise<void> {
  await navigateToView(page, 'Pages')
  await expect(page.locator(DAY)).toHaveCount(0)
  await navigateToView(page, 'Journal')
}

test.describe('the journal’s daily view in page mode (#5691) @journal @editor', () => {
  test('with Edit pages as on Page, the day is one document, and what is typed there stays', async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem('agaric-edit-mode', 'page'))
    await waitForBoot(page)

    const blocks = page.locator(`${EDITOR} [data-page-block]`)
    await expect(blocks).toHaveCount(SEEDED_BLOCKS)
    await expect(page.locator(`${DAY} li[data-block-id]`)).toHaveCount(0)
    await expect(page.locator(DAY).getByRole('button', { name: 'Add block' })).toHaveCount(0)
    await expect(
      page.getByRole('radiogroup', { name: 'Editing mode' }).getByRole('radio', { name: 'Page' }),
    ).toHaveAttribute('aria-checked', 'true')

    await caret(page, 1, 'Review project milestones'.length)
    await page.keyboard.type(' typed here')
    await expect(blocks.nth(1)).toContainText('Review project milestones typed here')
    await leaveAndReturn(page)

    await expect(blocks.nth(1)).toContainText('Review project milestones typed here')
    expect((await backendTexts(page))[1]).toBe('Review project milestones typed here')
  })

  test('Ctrl+E switches the day to page mode and back, keeping the caret and the block at the top', async ({
    page,
  }) => {
    await waitForBoot(page)
    const { blocks: seeded } = await ipc<{ blocks: Array<{ id: string }> }>(
      page,
      'create_blocks_batch',
      {
        specs: Array.from({ length: 80 }, (_, i) => ({
          blockType: 'content',
          content: `block ${i}`,
          parentId: TODAY_PAGE,
          position: null,
        })),
      },
    )
    const ids = seeded.map((b) => b.id)
    await leaveAndReturn(page)
    const row = (id: string | undefined) => page.locator(`${DAY} li[data-block-id="${id}"]`)
    await expect(row(ids[0])).toBeVisible()
    await row(ids[40]).evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await page.locator('#main-content').evaluate((el) => el.scrollBy(0, -10))
    const roving = page.locator(ROVING)
    await focusBlockById(page, ids[42] as string)
    await expect(roving).toBeFocused()
    await selectEditorRange(page, 3, 3)
    const inBlocks = await topBlock(page)
    expect(inBlocks?.id).toBe(ids[39])

    await page.keyboard.press('Control+e')

    await expect(page.locator(EDITOR)).toBeFocused()
    await expect.poll(() => cursor(page)).toEqual({ index: SEEDED_BLOCKS + 42, offset: 3 })
    await expect.poll(() => topBlock(page)).toEqual(inBlocks)
    await page.keyboard.type('!')

    await page.keyboard.press('Control+e')

    await expect(roving).toHaveText('blo!ck 42')
    await expect(roving).toBeFocused()
    await page.keyboard.type('?')
    await expect(roving).toHaveText('blo!?ck 42')
    await page.keyboard.press('Escape')
    await leaveAndReturn(page)
    await row(ids[42]).scrollIntoViewIfNeeded()
    await expect(row(ids[42])).toContainText('blo!?ck 42')
    expect((await backendTexts(page))[SEEDED_BLOCKS + 42]).toBe('blo!?ck 42')
  })
})
