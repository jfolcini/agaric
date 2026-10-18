/**
 * A done or cancelled task in block mode is struck through and muted by the
 * `text-muted-foreground` token. Half opacity measured 3.4:1 against WCAG's
 * 4.5:1, and happy-dom computes no colours, so this is the one place the
 * contrast is measured.
 */

import { createRequire } from 'node:module'

import { expect, ipc, openPage, test, waitForBoot, waitForStableBlockRows } from './helpers'

const axePath = createRequire(import.meta.url).resolve('axe-core')
const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const TITLE = 'Closed task contrast'

interface AxeNode {
  html: string
}
interface AxeResult {
  violations: Array<{ id: string; nodes: AxeNode[] }>
  passes: Array<{ id: string; nodes: AxeNode[] }>
  incomplete: Array<{ id: string; nodes: AxeNode[] }>
}

test.describe('closed tasks in block mode', () => {
  test('done and cancelled text clears 4.5:1, and axe measured it', async ({ page }) => {
    // axe reads colours, which a fade in progress makes wrong.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitForBoot(page)
    const pageId = await ipc<string>(page, 'create_page_in_space', {
      parentId: null,
      content: TITLE,
      spaceId: SCOPE.space_id,
    })
    for (const [content, state] of [
      ['shipped', 'DONE'],
      ['dropped', 'CANCELLED'],
      ['plain', null],
    ] as const) {
      const row = await ipc<{ id: string }>(page, 'create_block', {
        blockType: 'content',
        content,
        parentId: pageId,
        index: null,
        scope: SCOPE,
      })
      if (state) await ipc(page, 'set_todo_state', { blockId: row.id, state })
    }
    await openPage(page, TITLE)
    await waitForStableBlockRows(page, 3)
    await expect(page.locator('.sortable-block .line-through')).toHaveCount(2)

    await page.addScriptTag({ path: axePath })
    const result = await page.evaluate(() =>
      (
        window as unknown as {
          axe: {
            run: (el: Element, opts: { runOnly: string[] }) => Promise<AxeResult>
          }
        }
      ).axe.run(document.querySelector('.page-editor') as Element, {
        runOnly: ['color-contrast'],
      }),
    )

    expect(result.violations).toEqual([])
    // Under `opacity`, axe cannot measure the text and files it as `incomplete`
    // rather than as a violation, so a measured pass is the assertion.
    expect(result.incomplete.flatMap((r) => r.nodes).map((n) => n.html)).toEqual([])
    const measured = (text: string) =>
      result.passes.flatMap((r) => r.nodes).some((n) => n.html.includes(text))
    expect(measured('shipped')).toBe(true)
    expect(measured('dropped')).toBe(true)
  })
})
