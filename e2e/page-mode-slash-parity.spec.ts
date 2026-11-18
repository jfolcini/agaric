import type { Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import { activeSuggestionPopup, expect, focusBlockById, ipc, test, waitForBoot } from './helpers'

/**
 * A slash command in page mode leaves the backend as block mode's does (#5691). Kept off
 * `REAL_BACKEND_SPECS` until #6935: on the real backend, block mode's half sometimes saves the
 * text from before `/h2` after the command's write, and the merge doubles a trailing space.
 * Listing this file there is that issue's regression test.
 */

const SCOPE = { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL }
const EDITOR = '[data-testid="page-mode-editor"]'

interface Seeded {
  pageId: string
  ids: string[]
}

async function seedRows(page: Page, title: string, rows: readonly string[]): Promise<Seeded> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SCOPE.space_id,
  })
  const ids: string[] = []
  for (const content of rows) {
    const row = await ipc<{ id: string }>(page, 'create_block', {
      blockType: 'content',
      content,
      parentId: pageId,
      index: null,
      scope: SCOPE,
    })
    ids.push(row.id)
  }
  return { pageId, ids }
}

async function openViaPalette(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+k')
  await page.locator('[cmdk-input]').first().fill(title)
  await page.locator('[cmdk-item]').filter({ hasText: title }).first().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
  await expect(page.getByTestId('view-transition-wrapper')).toHaveCSS('opacity', '1')
}

function modeSwitch(page: Page, name: 'Blocks' | 'Page') {
  return page.getByRole('radiogroup', { name: 'Editing mode' }).getByRole('radio', { name })
}

/** Put the page-mode cursor at the end of block `index`, once ProseMirror's focus has settled. */
async function caretAtEnd(page: Page, index: number): Promise<void> {
  await page.evaluate(
    ({ selector, index: i }) => {
      const { editor } = document.querySelector(selector) as HTMLElement & {
        editor: {
          state: {
            doc: {
              child: (n: number) => { nodeSize: number; firstChild: { content: { size: number } } }
            }
          }
          commands: { setTextSelection: (pos: number) => boolean }
          view: { focus: () => void }
        }
      }
      let pos = 0
      for (let k = 0; k < i; k += 1) pos += editor.state.doc.child(k).nodeSize
      editor.commands.setTextSelection(pos + 2 + editor.state.doc.child(i).firstChild.content.size)
      editor.view.focus()
      return new Promise((resolve) => setTimeout(resolve, 20))
    },
    { selector: EDITOR, index },
  )
  await expect(page.locator(EDITOR)).toBeFocused()
}

test.describe('page mode slash commands, against block mode (#5691) @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a slash command leaves the backend as block mode’s does', async ({ page }) => {
    const pages = {
      blocks: await seedRows(page, 'Slash in blocks', ['buy milk', 'call mom']),
      page: await seedRows(page, 'Slash in page', ['buy milk', 'call mom']),
    }
    const menu = activeSuggestionPopup(page)
    const rows = (seeded: Seeded) =>
      Promise.all(
        seeded.ids.map(async (id) => {
          const row = await ipc<{ content: string; todo_state: string | null }>(page, 'get_block', {
            blockId: id,
          })
          return [row.content, row.todo_state]
        }),
      )

    await openViaPalette(page, 'Slash in blocks')
    for (const [i, command] of ['todo', 'h2'].entries()) {
      await focusBlockById(page, pages.blocks.ids[i] as string)
      await page.keyboard.press('End')
      await page.keyboard.type(` /${command}`)
      await menu.locator(`#suggestion-${command}`).click()
      await expect(menu).toHaveCount(0)
      await page.keyboard.press('Escape')
    }

    await openViaPalette(page, 'Slash in page')
    await modeSwitch(page, 'Page').click()
    await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(2)
    for (const [i, command] of ['todo', 'h2'].entries()) {
      await caretAtEnd(page, i)
      await page.keyboard.type(` /${command}`)
      await menu.locator(`#suggestion-${command}`).click()
      await expect(menu).toHaveCount(0)
    }
    await page.keyboard.press('Escape')

    await expect.poll(() => rows(pages.page)).toEqual(await rows(pages.blocks))
    expect(await rows(pages.blocks)).toEqual([
      ['buy milk ', 'TODO'],
      ['## call mom ', null],
    ])
  })
})
