/**
 * In-page replace (#6608): `Ctrl+H` opens the find bar with its replace row.
 * Replace changes the current match and moves on; Replace all changes every
 * block of a long page, rows not mounted included, through the block save, and
 * one Ctrl+Z takes the whole run back. A match in a chip's label is found and
 * left as it is. In page mode the same row edits the page's one editor.
 * Every check reads the backend, after leaving the page and coming back.
 */
import type { Page } from '@playwright/test'

import { expect, ipc, openPage, reopenPage, test, waitForBoot } from './helpers'

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const TITLE = 'Replace Long Page'
const ROWS = 200

/** A page of `ROWS` rows, `needle` in every fifth, and one `needle` that is a link's label. */
async function seedLongPage(page: Page): Promise<string> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: TITLE,
    spaceId: SCOPE.space_id,
  })
  const content = (i: number): string => {
    if (i === 0) return `see [[${pageId}|needle link]]`
    return `row ${i}${i % 5 === 4 ? ' needle' : ''}`
  }
  await ipc(page, 'create_blocks_batch', {
    specs: Array.from({ length: ROWS }, (_, i) => ({
      blockType: 'content',
      content: content(i),
      parentId: pageId,
      position: null,
    })),
  })
  return pageId
}

/** The text of every block of the page, as the backend holds it. */
async function stored(page: Page, pageId: string): Promise<string[]> {
  const { blocks } = await ipc<{
    blocks: Array<{ parent_id: string; position: number; content: string | null }>
  }>(page, 'load_page_subtree', { rootBlockId: pageId, scope: SCOPE })
  return blocks
    .filter((b) => b.parent_id === pageId)
    .toSorted((a, b) => a.position - b.position)
    .map((b) => b.content ?? '')
}

/** How many stored blocks hold `text`. */
async function storedCount(page: Page, pageId: string, text: string): Promise<number> {
  return (await stored(page, pageId)).filter((c) => c.includes(text)).length
}

async function openReplace(page: Page) {
  await page.keyboard.press('Control+h')
  await expect(page.getByRole('toolbar', { name: /find/i })).toBeVisible()
  return {
    find: page.getByTestId('in-page-find-input'),
    replace: page.getByRole('textbox', { name: 'Replace with' }),
    counter: page.getByTestId('in-page-find-counter'),
    status: page.getByTestId('in-page-replace-status'),
  }
}

test.describe('In-page replace @pages @search @editor', () => {
  test('replaces one and all in a long page, and one Ctrl+Z undoes a replace all', async ({
    page,
  }) => {
    await waitForBoot(page)
    const pageId = await seedLongPage(page)
    await openPage(page, TITLE)

    const bar = await openReplace(page)
    await expect(bar.find).toBeFocused()
    await bar.find.fill('needle')
    await expect(bar.counter).toHaveText('1 of 41')
    await expect(bar.status).toHaveText(
      '1 match is in a link, tag or block reference and will be left as it is',
    )

    // Replace takes the current match, the chip's, past: it stays, and the bar moves on.
    await bar.replace.fill('pin')
    await bar.replace.press('Enter')
    await expect(bar.status).toHaveText('1 in a link, tag or reference left as it is')
    await expect(bar.counter).toHaveText('2 of 41')
    await bar.replace.press('Enter')
    await expect(bar.counter).toHaveText('2 of 40')
    await expect.poll(() => storedCount(page, pageId, 'row 4 pin')).toBe(1)

    await page.getByRole('button', { name: 'Replace all' }).click()
    await expect(bar.status).toHaveText(
      'Replaced 39 matches · 1 in a link, tag or reference left as it is',
    )
    await expect(bar.counter).toHaveText('1 of 1')

    await reopenPage(page, TITLE)
    expect(await storedCount(page, pageId, 'pin')).toBe(40)
    expect(await storedCount(page, pageId, 'needle')).toBe(1)
    await expect(page.getByText('row 4 pin', { exact: true })).toBeVisible()

    // A second replace all, then one Ctrl+Z puts every block it changed back.
    const again = await openReplace(page)
    await again.find.fill('pin')
    await expect(again.counter).toHaveText('1 of 40')
    await again.replace.fill('thread')
    await page.getByRole('button', { name: 'Replace all' }).click()
    await expect(again.status).toHaveText('Replaced 40 matches')
    await expect.poll(() => storedCount(page, pageId, 'thread')).toBe(40)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('toolbar', { name: /find/i })).toHaveCount(0)
    await page.keyboard.press('Control+z')
    await expect.poll(() => storedCount(page, pageId, 'pin')).toBe(40)
    expect(await storedCount(page, pageId, 'thread')).toBe(0)

    await reopenPage(page, TITLE)
    expect(await storedCount(page, pageId, 'pin')).toBe(40)
    await expect(page.getByText('row 4 pin', { exact: true })).toBeVisible()
  })

  test('replaces in page mode, through its editor', async ({ page }) => {
    await waitForBoot(page)
    const pageId = await ipc<string>(page, 'create_page_in_space', {
      parentId: null,
      content: 'Replace Page Mode',
      spaceId: SCOPE.space_id,
    })
    for (const content of ['one **needle** here', 'two needle there']) {
      await ipc(page, 'create_block', {
        blockType: 'content',
        content,
        parentId: pageId,
        index: null,
        scope: SCOPE,
      })
    }
    await openPage(page, 'Replace Page Mode')
    await page
      .getByRole('radiogroup', { name: 'Editing mode' })
      .getByRole('radio', { name: 'Page' })
      .click()
    await expect(page.locator('[data-testid="page-mode-editor"] [data-page-block]')).toHaveCount(2)

    const bar = await openReplace(page)
    await bar.find.fill('needle')
    await expect(bar.counter).toHaveText('1 of 2')
    await bar.replace.fill('pin')
    await page.getByRole('button', { name: 'Replace all' }).click()
    await expect(bar.status).toHaveText('Replaced 2 matches')
    await expect(page.getByTestId('page-mode-editor')).toContainText('one pin here')

    await page.keyboard.press('Escape')
    await reopenPage(page, 'Replace Page Mode')
    await expect.poll(() => stored(page, pageId)).toEqual(['one **pin** here', 'two pin there'])
  })
})
