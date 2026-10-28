import type { Locator, Page } from '@playwright/test'

import {
  expect,
  focusBlock,
  ipc,
  openPage,
  reopenPage,
  replaceEditorText,
  saveBlock,
  test,
  waitForBoot,
  waitForStableBlockRows,
} from './helpers'

/**
 * A list marker shows only on a bullet or numbered block, in block mode and in
 * page mode. A list block made a heading or a code block by its Markdown typed
 * at its start (`# `, ```` ``` ````) leaves the list, and a heading that carries
 * a style anyway (an import, another device) shows no marker. Each mode is
 * checked after navigating away and back, against the style the backend holds.
 *
 * Seed: "Getting Started" has 5 blocks.
 */

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const EDITOR = '[data-testid="page-mode-editor"]'
const BULLET = {
  value_text: 'bullet',
  value_num: null,
  value_date: null,
  value_ref: null,
  value_bool: null,
}

const rows = (page: Page) => page.locator('[data-testid="sortable-block"]')
// The static block's `ListMarker` and the roving editor's decoration share the class.
const marker = (row: Locator) => row.locator('.list-marker')

async function styleOf(page: Page, blockId: string): Promise<string | null> {
  const props = await ipc<Array<{ key: string; value_text: string | null }>>(
    page,
    'get_properties',
    { blockId },
  )
  return props.find((row) => row.key === 'listStyle')?.value_text ?? null
}

async function openViaPalette(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+k')
  await page.locator('[cmdk-input]').first().fill(title)
  await page.locator('[cmdk-item]').filter({ hasText: title }).first().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
}

/** Empty the block at `index`, type `text` into it, and leave it. */
async function retype(page: Page, index: number, text: string): Promise<void> {
  await focusBlock(page, index)
  await replaceEditorText(page, '')
  await page.keyboard.type(text, { delay: 30 })
  await saveBlock(page, 'Escape')
}

test.describe('a list marker shows only on a list block @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('block mode: `# ` or a fence typed in a bullet block leaves the list; a heading with a style shows none', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    await waitForStableBlockRows(page, 5)
    const ids = await rows(page).evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-block-id') ?? ''),
    )
    // `- ` then a character makes the block a bullet, and the Markdown after it makes it a
    // heading or a code block: the path that left them flagged as bullets.
    await retype(page, 0, '- # Title')
    await retype(page, 1, '- ``` code')
    await retype(page, 2, '- item')
    // A heading carrying a style it never left, as an import stores one.
    await ipc(page, 'edit_block', { blockId: ids[3], toText: '# Imported' })
    await ipc(page, 'set_property', { blockId: ids[3], key: 'listStyle', value: BULLET })

    await reopenPage(page, 'Getting Started')
    await waitForStableBlockRows(page, 5)
    await expect(rows(page).nth(0).locator('h1')).toHaveText('Title')
    await expect(rows(page).nth(1).locator('pre')).toContainText('code')
    expect(await Promise.all(ids.slice(0, 4).map((id) => styleOf(page, id as string)))).toEqual([
      null,
      null,
      'bullet',
      'bullet',
    ])
    await expect(marker(rows(page).nth(2))).toHaveText('•')
    await expect(page.locator('.list-marker')).toHaveCount(1)

    // The roving editor agrees with the static block on each.
    await focusBlock(page, 2)
    await expect(marker(rows(page).nth(2))).toHaveText('•')
    await saveBlock(page, 'Escape')
    await focusBlock(page, 3)
    await expect(rows(page).nth(3).locator('[data-testid="block-editor"] h1')).toBeVisible()
    await expect(page.locator('.list-marker')).toHaveCount(1)
  })

  test('page mode: `# ` or a fence typed in a bullet block leaves the list; a heading with a style shows none', async ({
    page,
  }) => {
    const { ids } = await page.evaluate(
      async ({ scope }) => {
        const call = (cmd: string, args: Record<string, unknown>) =>
          (
            window as unknown as {
              __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> }
            }
          ).__TAURI_INTERNALS__.invoke(cmd, args)
        const pageId = (await call('create_page_in_space', {
          parentId: null,
          content: 'Page list kinds',
          spaceId: scope.space_id,
        })) as string
        const made: string[] = []
        for (const content of ['one', 'two', 'three', '# Imported']) {
          const row = (await call('create_block', {
            blockType: 'content',
            content,
            parentId: pageId,
            index: null,
            scope,
          })) as { id: string }
          made.push(row.id)
        }
        return { ids: made }
      },
      { scope: SCOPE },
    )
    for (const id of ids) {
      await ipc(page, 'set_property', { blockId: id, key: 'listStyle', value: BULLET })
    }
    const blocks = page.locator(`${EDITOR} [data-page-block]`)
    const markers = () =>
      blocks.evaluateAll((els) =>
        els.map(
          (el) => el.querySelector(':scope > [data-testid="list-marker"]')?.textContent ?? '',
        ),
      )
    const inPageMode = async () => {
      await openViaPalette(page, 'Page list kinds')
      await page
        .getByRole('radiogroup', { name: 'Editing mode' })
        .getByRole('radio', { name: 'Page' })
        .click()
      await expect(blocks).toHaveCount(4)
    }
    /** Put the caret at the start of block `index`'s text. */
    const caretAtStart = (index: number) =>
      page.evaluate(
        ({ selector, i }) => {
          const { editor } = document.querySelector(selector) as HTMLElement & {
            editor: {
              state: { doc: { child: (n: number) => { nodeSize: number } } }
              commands: { setTextSelection: (pos: number) => boolean }
              view: { focus: () => void }
            }
          }
          let pos = 0
          for (let k = 0; k < i; k += 1) pos += editor.state.doc.child(k).nodeSize
          editor.commands.setTextSelection(pos + 2)
          editor.view.focus()
          return new Promise((resolve) => setTimeout(resolve, 20))
        },
        { selector: EDITOR, i: index },
      )

    await inPageMode()
    await expect.poll(markers).toEqual(['•', '•', '•', ''])
    await caretAtStart(0)
    await page.keyboard.type('# ', { delay: 30 })
    await caretAtStart(1)
    await page.keyboard.type('``` ', { delay: 30 })
    await expect.poll(markers).toEqual(['', '', '•', ''])
    await expect
      .poll(() => Promise.all(ids.map((id) => styleOf(page, id))))
      .toEqual([null, null, 'bullet', 'bullet'])

    await openViaPalette(page, 'Getting Started')
    await inPageMode()
    await expect(blocks.nth(0).locator('h1')).toHaveText('one')
    await expect(blocks.nth(1).locator('pre')).toContainText('two')
    await expect.poll(markers).toEqual(['', '', '•', ''])
    expect(await Promise.all(ids.map((id) => styleOf(page, id)))).toEqual([
      null,
      null,
      'bullet',
      'bullet',
    ])
  })
})
