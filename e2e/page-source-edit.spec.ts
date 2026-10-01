import type { Locator, Page } from '@playwright/test'
import { devices } from '@playwright/test'

import {
  activeAlertDialog,
  activeDialog,
  expect,
  focusBlockById,
  openPage,
  openPageMobile,
  reopenPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * Edit as Markdown (#5140, #5160): the page kebab swaps the block tree for the
 * page's markdown, a plain-text editor whose lines carry their block ids out
 * of sight, and Save writes the text and those ids back through
 * `apply_page_source`; Merge saves a stale buffer with the page's changes
 * folded in. Every edit is typed, cut or pasted with the keyboard, and every
 * assertion reads the block tree the save reloaded from the mock. The Rust
 * tests own the grammar; the real-backend twins are
 * `e2e-tauri/page-source-edit.e2e.ts` and `e2e-tauri/page-source-merge.e2e.ts`.
 */

const PAGE = 'Getting Started'
const GS1 = '0000000000000000000BLOCK01'
const GS2 = '0000000000000000000BLOCK02'
const GS3 = '0000000000000000000BLOCK03'
const GS4 = '0000000000000000000BLOCK04'
const GS5 = '0000000000000000000BLOCK05'
const WELCOME = 'Welcome to Agaric!'
const HELLO_LINE = '- Hello, Agaric! This is your personal knowledge base.'
const CREATE = 'Create new blocks'
const SEARCH = 'Use the search panel'

/** The page kebab: it opens source mode, and closing source mode focuses it again. */
function pageActions(page: Page): Locator {
  return page.getByRole('button', { name: 'Page actions', exact: true })
}

/** The page's own aliases, the front matter its buffer opens with (#5160 S8), its lines carrying no id. */
const FRONT_MATTER: Array<[string, string | null]> = [
  ['---', null],
  ['aliases: [getting-started, gs]', null],
  ['---', null],
  ['', null],
]

async function openSourceMode(page: Page): Promise<Locator> {
  await pageActions(page).click()
  await page.getByRole('menuitem', { name: 'Edit as Markdown', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
  await expect(editor).toContainText(WELCOME)
  return editor
}

/** The buffer line holding `text`. */
function sourceLine(editor: Locator, text: string): Locator {
  return editor.locator('[data-source-line]', { hasText: text })
}

/** The buffer's lines: each one's text and the block id it carries. */
function bufferLines(editor: Locator): Promise<Array<[string, string | null]>> {
  return editor
    .locator('[data-source-line]')
    .evaluateAll((lines) =>
      lines.map((line): [string, string | null] => [
        line.textContent ?? '',
        line.getAttribute('data-block-id'),
      ]),
    )
}

/** Select the whole text of the line holding `text`, as a triple click does. */
async function selectLine(editor: Locator, text: string): Promise<void> {
  await sourceLine(editor, text).click({ clickCount: 3 })
}

/**
 * Press `key`, a key the browser moves the selection with, and wait for the
 * editor to read the moved selection, which it does a moment later: a cut or
 * a paste pressed sooner acts on the selection before it.
 */
async function moveSelection(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key)
  await page.waitForFunction(() => {
    const dom = document.querySelector('[data-testid="page-source-editor"]') as HTMLElement & {
      editor: {
        state: { selection: { from: number; to: number } }
        view: { posAtDOM: (node: Node, offset: number) => number }
      }
    }
    const shown = window.getSelection()
    if (shown?.anchorNode == null || shown.focusNode == null) return false
    const ends = [
      dom.editor.view.posAtDOM(shown.anchorNode, shown.anchorOffset),
      dom.editor.view.posAtDOM(shown.focusNode, shown.focusOffset),
    ]
    const { from, to } = dom.editor.state.selection
    return Math.min(...ends) === from && Math.max(...ends) === to
  })
}

/** The caret at the end of the line holding `text`, however the line wraps. */
async function caretAtEnd(page: Page, editor: Locator, text: string): Promise<void> {
  await selectLine(editor, text)
  await moveSelection(page, 'ArrowRight')
}

/** Cut the line holding `text`, its line break with it, and paste it at the start of the line holding `before`. */
async function moveLine(page: Page, editor: Locator, text: string, before: string): Promise<void> {
  await selectLine(editor, text)
  await moveSelection(page, 'Shift+ArrowRight')
  await page.keyboard.press('ControlOrMeta+x')
  await selectLine(editor, before)
  await moveSelection(page, 'ArrowLeft')
  await page.keyboard.press('ControlOrMeta+v')
}

/** Remove the line holding `text`, line break and all. */
async function deleteLine(page: Page, editor: Locator, text: string): Promise<void> {
  await selectLine(editor, text)
  await moveSelection(page, 'Shift+ArrowRight')
  await page.keyboard.press('Delete')
}

/** The report a save leaves (#5160 X2). */
function saveReport(page: Page): Locator {
  return page.locator('[data-sonner-toast]').filter({ hasText: 'Markdown saved' })
}

function blockIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="sortable-block"]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-block-id') ?? ''))
}

function staticBlock(page: Page, id: string): Locator {
  return page.locator(`[data-testid="block-static"][data-block-id="${id}"]`)
}

// By test id, not role: while the conflict dialog is open Radix hides the
// buffer from the accessibility tree, so a role locator is already "hidden"
// before anything closes source mode.
function sourceEditor(page: Page): Locator {
  return page.getByTestId('page-source-editor')
}

async function editBlockElsewhere(page: Page, blockId: string, toText: string): Promise<void> {
  await page.evaluate(
    async ({ id, text }) => {
      const invoke = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__.invoke
      await invoke('edit_block', { blockId: id, toText: text })
    },
    { id: blockId, text: toText },
  )
}

test.describe('Edit as Markdown (#5140 Phase 4b)', () => {
  test.beforeEach(async ({ page, context }) => {
    // Cut and paste go through the system clipboard.
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await waitForBoot(page)
    await openPage(page, PAGE)
    await expect(staticBlock(page, GS1)).toBeVisible()
  })

  test('the buffer shows each block’s markdown without its id, which its first line carries', async ({
    page,
  }) => {
    const editor = await openSourceMode(page)

    await expect(editor).not.toContainText('^')
    const lines = await bufferLines(editor)
    expect(lines.slice(0, FRONT_MATTER.length)).toEqual(FRONT_MATTER)
    expect(lines.slice(FRONT_MATTER.length).map(([, id]) => id)).toEqual([
      GS1,
      GS2,
      GS3,
      GS4,
      GS5,
      null,
    ])
  })

  test('Save writes an edited line and a line moved by cut and paste, and the tree shows them', async ({
    page,
  }) => {
    const editor = await openSourceMode(page)

    await moveLine(page, editor, CREATE, WELCOME)
    await selectLine(editor, WELCOME)
    await page.keyboard.type(HELLO_LINE)
    await page.getByRole('button', { name: 'Save', exact: true }).click()

    await expect(sourceEditor(page)).toHaveCount(0)
    await expect(pageActions(page)).toBeFocused()
    await expect.poll(() => blockIds(page)).toEqual([GS3, GS1, GS2, GS4, GS5])
    await expect(staticBlock(page, GS1)).toContainText('Hello, Agaric!')
  })

  test('an edited line, a bullet added with Enter and a moved line persist as those blocks', async ({
    page,
  }) => {
    const editor = await openSourceMode(page)

    await caretAtEnd(page, editor, WELCOME)
    await page.keyboard.type(' Edited.')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Added with Enter')
    await moveLine(page, editor, SEARCH, 'Use the sidebar')
    const first = FRONT_MATTER.length
    expect((await bufferLines(editor)).slice(first, first + 3)).toEqual([
      ['- Welcome to Agaric! This is your personal knowledge base. Edited.', GS1],
      ['- Added with Enter', null],
      ['- **Use the search panel** to find anything across all your pages.', GS5],
    ])
    await editor.press('ControlOrMeta+s')
    await expect(sourceEditor(page)).toHaveCount(0)

    await reopenPage(page, PAGE)
    await expect.poll(async () => (await blockIds(page)).length).toBe(6)
    const ids = await blockIds(page)
    expect([ids[0], ids[2], ids[3], ids[4], ids[5]]).toEqual([GS1, GS5, GS2, GS3, GS4])
    await expect(staticBlock(page, GS1)).toContainText('knowledge base. Edited.')
    await expect(staticBlock(page, ids[1] as string)).toHaveText('Added with Enter')
    const reopened = await openSourceMode(page)
    expect((await bufferLines(reopened))[first + 1]).toEqual(['- Added with Enter', ids[1]])
  })

  test('a page changed since opening asks first, and Overwrite keeps the buffer', async ({
    page,
  }) => {
    const elsewhere = 'Edited on another device'
    const editor = await openSourceMode(page)
    await editBlockElsewhere(page, GS3, elsewhere)
    await selectLine(editor, WELCOME)
    await page.keyboard.type(HELLO_LINE)

    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const dialog = activeDialog(page)
    await expect(dialog.getByRole('heading', { name: 'This page changed' })).toBeVisible()
    await expect(dialog.getByRole('listitem')).toHaveCount(1)
    await expect(dialog.getByRole('listitem')).toContainText(elsewhere)
    await expect(dialog.getByRole('listitem')).not.toContainText('^')
    await dialog.getByRole('button', { name: 'Overwrite', exact: true }).click()

    await expect(sourceEditor(page)).toHaveCount(0)
    await expect(staticBlock(page, GS1)).toContainText('Hello, Agaric!')
    await expect(staticBlock(page, GS3)).toContainText(CREATE)
    await expect(page.getByText(elsewhere)).toHaveCount(0)
  })

  test('Merge saves the buffer with the change made since opening folded in', async ({ page }) => {
    const elsewhere = 'Edited on another device'
    const editor = await openSourceMode(page)
    await editBlockElsewhere(page, GS3, elsewhere)
    await selectLine(editor, WELCOME)
    await page.keyboard.type(HELLO_LINE)

    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await activeDialog(page).getByRole('button', { name: 'Merge', exact: true }).click()

    await expect(sourceEditor(page)).toHaveCount(0)
    await expect(pageActions(page)).toBeFocused()
    await expect(staticBlock(page, GS1)).toContainText('Hello, Agaric!')
    await expect(staticBlock(page, GS3)).toContainText(elsewhere)
    await expect.poll(() => blockIds(page)).toEqual([GS1, GS2, GS3, GS4, GS5])
  })

  // Opening the kebab blurs the editor, which commits the block before the
  // buffer is read; no flush of the focused block is left to do.
  test('what was just typed into a block is in the buffer', async ({ page }) => {
    await focusBlockById(page, GS1)
    await page.keyboard.press('End')
    await page.keyboard.type(' Typed just now.')

    const editor = await openSourceMode(page)

    await expect(sourceLine(editor, 'knowledge base. Typed just now.')).toHaveAttribute(
      'data-block-id',
      GS1,
    )
  })

  test('an alias typed into the front matter is saved, and the header shows it', async ({
    page,
  }) => {
    const editor = await openSourceMode(page)
    await caretAtEnd(page, editor, 'aliases: [getting-started, gs]')
    await moveSelection(page, 'ArrowLeft')
    await page.keyboard.type(', handbook')
    expect((await bufferLines(editor)).slice(0, 2)).toEqual([
      ['---', null],
      ['aliases: [getting-started, gs, handbook]', null],
    ])

    await page.getByRole('button', { name: 'Save', exact: true }).click()

    await expect(sourceEditor(page)).toHaveCount(0)
    await expect(pageActions(page)).toBeFocused()
    await expect(page.getByText('handbook', { exact: true })).toBeVisible()
  })

  test('Cancel with changes asks: Keep editing keeps the text, Discard leaves the page untouched', async ({
    page,
  }) => {
    const editor = await openSourceMode(page)
    await moveLine(page, editor, CREATE, WELCOME)
    await selectLine(editor, WELCOME)
    await page.keyboard.type(HELLO_LINE)
    const edited = await bufferLines(editor)
    const cancel = page.getByRole('button', { name: 'Cancel', exact: true })

    await cancel.click()
    const confirm = activeAlertDialog(page)
    await expect(confirm.getByRole('heading', { name: 'Discard your changes?' })).toBeVisible()
    await confirm.getByRole('button', { name: 'Keep editing', exact: true }).click()
    await expect(confirm).toHaveCount(0)
    expect(await bufferLines(editor)).toEqual(edited)

    await cancel.click()
    await activeAlertDialog(page).getByRole('button', { name: 'Discard', exact: true }).click()

    await expect(sourceEditor(page)).toHaveCount(0)
    await expect(pageActions(page)).toBeFocused()
    await expect.poll(() => blockIds(page)).toEqual([GS1, GS2, GS3, GS4, GS5])
    await expect(staticBlock(page, GS1)).toContainText(WELCOME)
  })

  test('Ctrl+S saves, and the report lists what the save deleted and created', async ({ page }) => {
    const editor = await openSourceMode(page)
    await deleteLine(page, editor, SEARCH)
    await caretAtEnd(page, editor, WELCOME)
    await page.keyboard.type(' See [[Brand New Page]]')

    await editor.press('ControlOrMeta+s')

    await expect(sourceEditor(page)).toHaveCount(0)
    await expect.poll(() => blockIds(page)).toEqual([GS1, GS2, GS3, GS4])
    await expect(saveReport(page)).toContainText('1 block deleted, 1 edited')
    await saveReport(page).getByRole('link', { name: 'Brand New Page', exact: true }).click()
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Brand New Page')
  })

  test('Undo in the report restores the page, as the buffer shows on reopening', async ({
    page,
  }) => {
    const editor = await openSourceMode(page)
    const base = await bufferLines(editor)
    await deleteLine(page, editor, SEARCH)
    await selectLine(editor, WELCOME)
    await page.keyboard.type(HELLO_LINE)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => blockIds(page)).toEqual([GS1, GS2, GS3, GS4])

    await saveReport(page).getByRole('button', { name: 'Undo', exact: true }).click()

    await expect.poll(() => blockIds(page)).toEqual([GS1, GS2, GS3, GS4, GS5])
    expect(await bufferLines(await openSourceMode(page))).toEqual(base)
  })
})

test.describe('Edit as Markdown on a 390 px phone', () => {
  const iPhone13 = devices['iPhone 13']
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  test('the page kebab is on screen and opens the buffer', async ({ page }) => {
    await waitForBoot(page)
    await openPageMobile(page, PAGE)

    await expect(pageActions(page)).toBeInViewport({ ratio: 1 })
    await openSourceMode(page)
  })
})
