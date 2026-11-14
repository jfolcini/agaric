import type { Page } from '@playwright/test'

import { expect, focusBlockById, ipc, openPage, reopenPage, test, waitForBoot } from './helpers'

/**
 * #6530: an `@` in ordinary prose is text. The picker's query ends at the
 * first space unless an existing tag still starts with it, so Enter after
 * `meet @ 5pm tomorrow` splits the block and creates no tag. `@work` and Enter
 * still pick the tag `work`. Read back from the mock backend, and the text
 * after navigating away and back.
 */

const PAGE = 'Getting Started'
const GS1 = '0000000000000000000B10CK01'
const TAG_REF = /^meet #\[([0-9A-Z]{26})\]$/

async function storedContent(page: Page): Promise<string> {
  return (await ipc<{ content: string }>(page, 'get_block', { blockId: GS1 })).content
}

function tags(page: Page): Promise<Array<{ tag_id: string; name: string }>> {
  return ipc(page, 'list_all_tags_in_space', {
    scope: { kind: 'active', space_id: 'SPACE_PERSONAL' },
  })
}

async function tagNames(page: Page): Promise<string[]> {
  return (await tags(page)).map((row) => row.name).toSorted()
}

const rows = (page: Page) => page.locator('[data-testid="sortable-block"]')

test.describe('An @ in prose stays text (#6530) @editor', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await ipc(page, 'edit_block', { blockId: GS1, toText: 'meet' })
    await openPage(page, PAGE)
  })

  for (const prose of [
    ' @ 5pm tomorrow',
    ' @alice about the review and the budget for next quarter please',
  ]) {
    test(`"meet${prose}" and Enter split the block and create no tag`, async ({ page }) => {
      const before = await rows(page).count()
      const editor = await focusBlockById(page, GS1)
      await editor.press('End')
      await page.keyboard.type(prose, { delay: 30 })
      await page.keyboard.press('Enter')

      await expect(rows(page)).toHaveCount(before + 1)
      await expect.poll(() => storedContent(page)).toBe(`meet${prose}`)
      expect(await tagNames(page)).toEqual(['idea', 'personal', 'work'])

      await reopenPage(page, PAGE)
      await expect(page.locator(`[data-testid="block-static"][data-block-id="${GS1}"]`)).toHaveText(
        `meet${prose}`,
      )
    })
  }

  test('"@work" and Enter still pick the existing tag work', async ({ page }) => {
    const editor = await focusBlockById(page, GS1)
    await editor.press('End')
    await page.keyboard.type(' @work', { delay: 30 })
    await page.keyboard.press('Enter')
    await expect(editor.locator('[data-testid="tag-ref-chip"]')).toHaveText('work')
    await page.keyboard.press('Escape')

    await expect.poll(() => storedContent(page)).toMatch(TAG_REF)
    const id = TAG_REF.exec(await storedContent(page))?.[1]
    expect((await tags(page)).find((row) => row.tag_id === id)?.name).toBe('work')
    expect(await tagNames(page)).toEqual(['idea', 'personal', 'work'])
  })
})
