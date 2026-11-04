import { devices } from '@playwright/test'

import { blockRow } from './domain'
import {
  expect,
  focusBlock,
  openPage,
  openPageMobile,
  reopenPage,
  saveBlock,
  test,
  waitForBoot,
} from './helpers'

/**
 * E2E for #6033 S11 — footnotes. A typed `[^1]` becomes a superscript
 * reference, a block typed as `[^1]: note` defines it and shows the same number
 * as its marker, clicking the reference focuses the definition, and both blocks
 * store the text as typed.
 */

const PAGE = 'Getting Started'

type Page = import('@playwright/test').Page

interface InvokeWindow extends Window {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> }
}

/** A block's stored content, read back over IPC. */
function storedContent(page: Page, blockId: string): Promise<string> {
  return page.evaluate(async (id) => {
    const invoke = (window as unknown as InvokeWindow).__TAURI_INTERNALS__.invoke
    const block = (await invoke('get_block', { blockId: id })) as { content: string }
    return block.content
  }, blockId)
}

/** The id of the block the editor is in. */
async function editingBlockId(page: Page): Promise<string> {
  const row = page.locator('[data-testid="sortable-block"]:has([data-testid="block-editor"])')
  const id = await row.getAttribute('data-block-id')
  if (id === null) throw new Error('no block is being edited')
  return id
}

/** A page of `blocks`, in order, made over IPC. */
async function seedPage(page: Page, title: string, blocks: string[]): Promise<void> {
  await page.evaluate(
    async ({ title: content, blocks: texts }) => {
      const invoke = (window as unknown as InvokeWindow).__TAURI_INTERNALS__.invoke
      const pageId = (await invoke('create_page_in_space', {
        parentId: null,
        content,
        spaceId: 'SPACE_PERSONAL',
      })) as string
      await invoke('create_blocks_batch', {
        specs: texts.map((text) => ({
          blockType: 'content',
          content: text,
          parentId: pageId,
          position: null,
        })),
      })
    },
    { title, blocks },
  )
}

test.describe('footnotes typed as [^label] (#6033) @editor @markdown', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
    await expect(page.locator('[data-testid="sortable-block"]').first()).toBeVisible()
  })

  test('a reference shows its number and focuses its definition, both stored as typed', async ({
    page,
  }) => {
    const editor = await focusBlock(page, 0)
    const refId = await editingBlockId(page)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await editor.pressSequentially('Claim[^1]')
    await expect(editor.locator('sup[data-type="footnote-ref"]')).toHaveText('1')

    await page.keyboard.press('Enter')
    const defId = await editingBlockId(page)
    expect(defId).not.toBe(refId)
    await page
      .locator('[data-testid="block-editor"] [contenteditable="true"]')
      .pressSequentially('[^1]: note')
    await saveBlock(page, 'Escape')

    const definition = blockRow(page, defId)
    await expect(definition.getByTestId('footnote-definition')).toHaveText('1')
    await expect(definition.getByTestId('block-static')).toHaveText('1note')

    await blockRow(page, refId).getByRole('link', { name: 'Footnote 1' }).click()
    await expect(
      definition.locator('[data-testid="block-editor"] [contenteditable="true"]'),
    ).toBeFocused()

    await reopenPage(page, PAGE)
    await expect(blockRow(page, refId).getByRole('link', { name: 'Footnote 1' })).toBeVisible()
    expect(await storedContent(page, refId)).toBe('Claim[^1]')
    expect(await storedContent(page, defId)).toBe('[^1]: note')
  })
})

const iPhone13 = devices['iPhone 13']

test.describe('footnote reference touch target (#6033) @mobile @editor', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  test('a reference that can be followed takes a tap in a 44 px box around it', async ({
    page,
  }) => {
    await waitForBoot(page)
    await seedPage(page, 'Phone footnotes', [
      'Prose before the claim[^a] and prose after it.',
      '[^a]: the note',
    ])
    await openPageMobile(page, 'Phone footnotes')
    const reference = page.getByRole('link', { name: 'Footnote 1' })
    await expect(reference).toBeVisible()
    // A tap 21 px left, right, above and below the centre: a 44 px box less a pixel.
    const taps = await reference.evaluate((node) => {
      const box = node.getBoundingClientRect()
      const x = box.left + box.width / 2
      const y = box.top + box.height / 2
      return [
        [x - 21, y],
        [x + 21, y],
        [x, y - 21],
        [x, y + 21],
      ].map(([px, py]) => node.contains(document.elementFromPoint(px ?? 0, py ?? 0)))
    })
    expect(taps, 'left, right, above and below the reference').toEqual([true, true, true, true])
  })
})

const EDITOR = '[data-testid="page-mode-editor"]'

test.describe('footnotes in page mode (#6033) @editor @markdown', () => {
  test('the numbers follow the typing, and a click puts the cursor in the definition', async ({
    page,
  }) => {
    await waitForBoot(page)
    await seedPage(page, 'Page mode footnotes', [
      'Claim A[^a] and B[^b]',
      '[^a]: Alpha',
      '[^b]: Beta',
    ])
    await page.keyboard.press('Control+k')
    await page.locator('[cmdk-input]').first().fill('Page mode footnotes')
    await page.locator('[cmdk-item]').filter({ hasText: 'Page mode footnotes' }).first().click()
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Page mode footnotes')
    await page
      .getByRole('radiogroup', { name: 'Editing mode' })
      .getByRole('radio', { name: 'Page' })
      .click()
    const references = page.locator(`${EDITOR} sup[data-type="footnote-ref"]`)
    await expect(references).toHaveText(['1', '2', '1', '2'])

    // B's reference is the second one: its definition is the third block.
    await references.nth(1).click()
    const cursorBlock = () =>
      page.evaluate((selector) => {
        const { editor } = document.querySelector(selector) as HTMLElement & {
          editor: { state: { selection: { $from: { index: (depth: number) => number } } } }
        }
        return editor.state.selection.$from.index(0)
      }, EDITOR)
    await expect.poll(cursorBlock).toBe(2)

    // A reference typed ahead of the others renumbers them as it is typed.
    await page.evaluate((selector) => {
      const { editor } = document.querySelector(selector) as HTMLElement & {
        editor: {
          commands: { setTextSelection: (position: number) => boolean }
          view: { focus: () => void }
        }
      }
      editor.commands.setTextSelection(2)
      editor.view.focus()
    }, EDITOR)
    await page.keyboard.type('Z[^z]')
    await expect(references).toHaveText(['1', '2', '3', '2', '3'])
  })
})
