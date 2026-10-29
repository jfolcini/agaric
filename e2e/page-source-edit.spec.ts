import type { Locator, Page } from '@playwright/test'
import { devices } from '@playwright/test'

import {
  activeAlertDialog,
  activeDialog,
  activeMenu,
  activePopover,
  activeSheet,
  activeSuggestionList,
  activeSuggestionPopup,
  expect,
  focusBlockById,
  ipc,
  openPage,
  openPageMobile,
  reopenPage,
  seedSearchBlocks,
  test,
  waitForBoot,
} from './helpers'

/**
 * Edit as Markdown (#5140, #5160): the page kebab swaps the block tree for the
 * page's markdown, a plain-text editor whose lines carry their block ids out
 * of sight, and Save writes the text and those ids back through
 * `apply_page_source`; Merge saves a stale buffer with the page's changes
 * folded in, and Reload swaps it for the page as it is now; unsaved text
 * left by leaving the page is a localStorage draft the buffer restores on
 * reopening. The buffer is the Document dialect (#5691): a plain block is its
 * own paragraph, a blank line between blocks, so a paragraph is moved with the
 * blank line after it. Every edit is typed, cut or pasted with the keyboard,
 * or dragged with the mouse, and every assertion reads the block tree the save
 * reloaded from the mock. The Rust tests own the grammar; the real-backend
 * twins are `e2e-tauri/page-source-edit.e2e.ts`,
 * `e2e-tauri/page-source-merge.e2e.ts`, `e2e-tauri/page-source-paste.e2e.ts`
 * and `e2e-tauri/page-source-document.e2e.ts`.
 */

const PAGE = 'Getting Started'
const GS1 = '0000000000000000000BLOCK01'
const GS2 = '0000000000000000000BLOCK02'
const GS3 = '0000000000000000000BLOCK03'
const GS4 = '0000000000000000000BLOCK04'
const GS5 = '0000000000000000000BLOCK05'
const WELCOME = 'Welcome to Agaric!'
const HELLO_LINE = 'Hello, Agaric! This is your personal knowledge base.'
const CREATE = 'Create new blocks'
const SEARCH = 'Use the search panel'
const NOTES = 'Quick Notes'
const QN1 = '0000000000000000000BLOCK08'
const QN2 = '0000000000000000000BLOCK09'
const JOT = 'Jot down quick thoughts'
const DRAFT_RESTORED = 'Restored your unsaved edits.'

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

async function openSourceMode(page: Page, shows = WELCOME): Promise<Locator> {
  await pageActions(page).click()
  await page.getByRole('menuitem', { name: 'Edit as Markdown', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
  await expect(editor).toContainText(shows)
  // The buffer focuses itself a task after its text shows, and ProseMirror
  // writes its own selection back over the DOM's shortly after a focus: a
  // click or key sent before then is undone.
  await expect(editor).toBeFocused()
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

/** The ids the buffer's lines carry, in order. */
async function bufferIds(editor: Locator): Promise<string[]> {
  return (await bufferLines(editor)).flatMap(([, id]) => (id === null ? [] : [id]))
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

/** Select the paragraph holding `text` with the blank line after it, which a move takes along. */
async function selectParagraph(page: Page, editor: Locator, text: string): Promise<void> {
  await selectLine(editor, text)
  await moveSelection(page, 'Shift+ArrowRight')
  await moveSelection(page, 'Shift+ArrowRight')
}

/** Cut the paragraph holding `text`, and paste it at the start of the line holding `before`. */
async function moveLine(page: Page, editor: Locator, text: string, before: string): Promise<void> {
  await selectParagraph(page, editor, text)
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

/** Back to a page opened before, by the quick-access bar, which `openPage`'s match also hits. */
async function backTo(page: Page, title: string): Promise<void> {
  await page.getByTestId('quick-access-bar').getByRole('button', { name: title }).click()
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
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

/** A button on the buffer's toolbar. */
function toolbarButton(page: Page, name: string | RegExp): Locator {
  return page.getByTestId('page-source-toolbar').getByRole('button', { name, exact: true })
}

/** Save, which counts the changes once there are any. */
const SAVE = /^Save(?: \(\d+ changes?\))?$/

function saveButton(page: Page): Locator {
  return page.getByRole('button', { name: SAVE })
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

test.describe('Edit as Markdown (#5140 Phase 4b) @editor @pages @markdown @mobile', () => {
  test.beforeEach(async ({ page, context }) => {
    // Cut and paste go through the system clipboard.
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await waitForBoot(page)
    await openPage(page, PAGE)
    await expect(staticBlock(page, GS1)).toBeVisible()
  })

  test('the focus ring goes round the toolbar and the text, from either', async ({ page }) => {
    const editor = await openSourceMode(page)
    const toolbar = page.getByTestId('page-source-toolbar')
    // The element painting the focus ring, Tailwind's `0 0 0 3px` box-shadow,
    // holds the whole toolbar inside its box.
    const ringHoldsToolbar = () =>
      editor.evaluate((text) => {
        let ringed: Element | null = text
        while (ringed !== null && !getComputedStyle(ringed).boxShadow.includes('0px 0px 0px 3px')) {
          ringed = ringed.parentElement
        }
        const bar = document.querySelector('[data-testid="page-source-toolbar"]')
        if (ringed === null || bar === null) return false
        const [outer, inner] = [ringed.getBoundingClientRect(), bar.getBoundingClientRect()]
        return (
          inner.top >= outer.top &&
          inner.left >= outer.left &&
          inner.right <= outer.right &&
          inner.bottom <= outer.bottom
        )
      })

    // The ring eases in (`transition-[color,box-shadow]`).
    await expect.poll(ringHoldsToolbar).toBe(true)
    await toolbar.getByRole('button').first().focus()
    await expect.poll(ringHoldsToolbar).toBe(true)
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
      null,
      GS2,
      null,
      GS3,
      null,
      GS4,
      null,
      GS5,
      null,
    ])
    expect(lines[FRONT_MATTER.length]?.[0]).toBe(`${WELCOME} This is your personal knowledge base.`)
  })

  test('Save writes an edited line and a line moved by cut and paste, and the tree shows them', async ({
    page,
  }) => {
    const editor = await openSourceMode(page)

    await moveLine(page, editor, CREATE, WELCOME)
    await selectLine(editor, WELCOME)
    await page.keyboard.type(HELLO_LINE)
    await saveButton(page).click()

    await expect(sourceEditor(page)).toHaveCount(0)
    await expect(pageActions(page)).toBeFocused()
    await expect.poll(() => blockIds(page)).toEqual([GS3, GS1, GS2, GS4, GS5])
    await expect(staticBlock(page, GS1)).toContainText('Hello, Agaric!')
  })

  test('an edited line, a paragraph added with Enter and a moved paragraph persist as those blocks', async ({
    page,
  }) => {
    const editor = await openSourceMode(page)

    await caretAtEnd(page, editor, WELCOME)
    await page.keyboard.type(' Edited.')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Added with Enter')
    await moveLine(page, editor, CREATE, 'Use the sidebar')
    const first = FRONT_MATTER.length
    expect((await bufferLines(editor)).slice(first, first + 5)).toEqual([
      ['Welcome to Agaric! This is your personal knowledge base. Edited.', GS1],
      ['', null],
      ['Added with Enter', null],
      ['', null],
      ['Create new blocks by pressing Enter at the end of any block.', GS3],
    ])
    await editor.press('ControlOrMeta+s')
    await expect(sourceEditor(page)).toHaveCount(0)

    await reopenPage(page, PAGE)
    await expect.poll(async () => (await blockIds(page)).length).toBe(6)
    const ids = await blockIds(page)
    expect([ids[0], ids[2], ids[3], ids[4], ids[5]]).toEqual([GS1, GS3, GS2, GS4, GS5])
    await expect(staticBlock(page, GS1)).toContainText('knowledge base. Edited.')
    await expect(staticBlock(page, ids[1] as string)).toHaveText('Added with Enter')
    const reopened = await openSourceMode(page)
    expect((await bufferLines(reopened))[first + 2]).toEqual(['Added with Enter', ids[1]])
  })

  test('a page changed since opening asks first, and Overwrite keeps the buffer', async ({
    page,
  }) => {
    const elsewhere = 'Edited on another device'
    const editor = await openSourceMode(page)
    await editBlockElsewhere(page, GS3, elsewhere)
    await selectLine(editor, WELCOME)
    await page.keyboard.type(HELLO_LINE)

    await saveButton(page).click()
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

    await saveButton(page).click()
    await activeDialog(page).getByRole('button', { name: 'Merge', exact: true }).click()

    await expect(sourceEditor(page)).toHaveCount(0)
    await expect(pageActions(page)).toBeFocused()
    await expect(staticBlock(page, GS1)).toContainText('Hello, Agaric!')
    await expect(staticBlock(page, GS3)).toContainText(elsewhere)
    await expect.poll(() => blockIds(page)).toEqual([GS1, GS2, GS3, GS4, GS5])
  })

  test('a line pasted from another page’s buffer saves as a new block, and that page is unchanged', async ({
    page,
  }) => {
    await openPage(page, NOTES)
    const notes = await openSourceMode(page, JOT)
    await selectLine(notes, JOT)
    await moveSelection(page, 'Shift+ArrowRight')
    await page.keyboard.press('ControlOrMeta+c')
    await notes.press('Escape')
    await expect(sourceEditor(page)).toHaveCount(0)

    await backTo(page, PAGE)
    const editor = await openSourceMode(page)
    // On the blank line above the first paragraph, so the line pasted is a paragraph of its own.
    await selectLine(editor, WELCOME)
    await moveSelection(page, 'ArrowLeft')
    await moveSelection(page, 'ArrowUp')
    await page.keyboard.press('ControlOrMeta+v')
    await saveButton(page).click()

    await expect(sourceEditor(page)).toHaveCount(0)
    await expect(saveReport(page)).toBeVisible()
    await expect(saveReport(page)).not.toContainText('not a block of this page')
    await expect.poll(async () => (await blockIds(page)).length).toBe(6)
    const [pasted, ...rest] = await blockIds(page)
    expect(rest).toEqual([GS1, GS2, GS3, GS4, GS5])
    expect([QN1, QN2]).not.toContain(pasted)
    await expect(staticBlock(page, pasted as string)).toContainText(JOT)
    await backTo(page, NOTES)
    await expect.poll(() => blockIds(page)).toEqual([QN1, QN2])
  })

  test('a paragraph dragged to where another starts moves its block', async ({ page }) => {
    const editor = await openSourceMode(page)
    await selectParagraph(page, editor, CREATE)
    const from = await sourceLine(editor, CREATE).boundingBox()
    const to = await sourceLine(editor, WELCOME).boundingBox()
    if (from === null || to === null) throw new Error('a buffer line has no box')

    await page.mouse.move(from.x + 20, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(to.x + 1, to.y + to.height / 2, { steps: 10 })
    await page.mouse.up()
    const first = FRONT_MATTER.length
    expect((await bufferLines(editor)).slice(first, first + 3).map(([, id]) => id)).toEqual([
      GS3,
      null,
      GS1,
    ])
    await saveButton(page).click()

    await expect(sourceEditor(page)).toHaveCount(0)
    await expect.poll(() => blockIds(page)).toEqual([GS3, GS1, GS2, GS4, GS5])
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

    await saveButton(page).click()

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

  test('text left unsaved by going to another page is restored on reopening, until Discard', async ({
    page,
  }) => {
    const kept = 'knowledge base. Kept as a draft.'
    const editor = await openSourceMode(page)
    await caretAtEnd(page, editor, WELCOME)
    await page.keyboard.type(' Kept as a draft.')

    await openPage(page, NOTES)
    await backTo(page, PAGE)
    await expect(staticBlock(page, GS1)).toContainText(WELCOME)
    await expect(staticBlock(page, GS1)).not.toContainText('Kept as a draft.')
    const restored = await openSourceMode(page)

    await expect(page.getByText(DRAFT_RESTORED, { exact: true })).toBeVisible()
    await expect(sourceLine(restored, kept)).toHaveAttribute('data-block-id', GS1)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await activeAlertDialog(page).getByRole('button', { name: 'Discard', exact: true }).click()
    await expect(sourceEditor(page)).toHaveCount(0)

    const reopened = await openSourceMode(page)
    await expect(page.getByText(DRAFT_RESTORED, { exact: true })).toHaveCount(0)
    await expect(sourceLine(reopened, WELCOME)).not.toContainText('Kept as a draft.')
  })

  test('Reload swaps the buffer for the page as changed elsewhere, saving nothing and leaving no draft', async ({
    page,
  }) => {
    const elsewhere = 'Edited on another device'
    const editor = await openSourceMode(page)
    await editBlockElsewhere(page, GS3, elsewhere)
    await selectLine(editor, WELCOME)
    await page.keyboard.type(HELLO_LINE)

    await saveButton(page).click()
    await activeDialog(page).getByRole('button', { name: 'Reload', exact: true }).click()

    await expect(activeDialog(page)).toHaveCount(0)
    await expect(sourceLine(editor, elsewhere)).toHaveAttribute('data-block-id', GS3)
    await expect(sourceLine(editor, WELCOME)).toHaveAttribute('data-block-id', GS1)
    await expect(editor).not.toContainText('Hello, Agaric!')
    await expect(saveButton(page)).toBeDisabled()

    // Leaving with the buffer open stores whatever it last typed as a draft.
    await reopenPage(page, PAGE)
    await expect(staticBlock(page, GS1)).toContainText(WELCOME)
    await expect(staticBlock(page, GS3)).toContainText(elsewhere)
    const reopened = await openSourceMode(page, 'Use the sidebar')
    await expect(page.getByText(DRAFT_RESTORED, { exact: true })).toHaveCount(0)
    await expect(reopened).toContainText(WELCOME)
    await expect(reopened).not.toContainText('Hello, Agaric!')
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
    await saveButton(page).click()
    await expect.poll(() => blockIds(page)).toEqual([GS1, GS2, GS3, GS4])

    await saveReport(page).getByRole('button', { name: 'Undo', exact: true }).click()

    await expect.poll(() => blockIds(page)).toEqual([GS1, GS2, GS3, GS4, GS5])
    expect(await bufferLines(await openSourceMode(page))).toEqual(base)
  })

  test('Tab indents a paragraph, which saves as a child of the block above it', async ({
    page,
  }) => {
    const editor = await openSourceMode(page)
    const second = FRONT_MATTER.length + 2
    await caretAtEnd(page, editor, 'Use the sidebar')

    await page.keyboard.press('Tab')

    await expect(editor).toBeFocused()
    const indented = await bufferLines(editor)
    expect(indented[second]?.[0]).toMatch(/^ {2}Use the sidebar/)
    expect(indented[second]?.[1]).toBe(GS2)
    await editor.press('ControlOrMeta+s')
    await expect(sourceEditor(page)).toHaveCount(0)
    await reopenPage(page, PAGE)
    expect((await bufferLines(await openSourceMode(page)))[second]).toEqual(indented[second])
  })

  test('the move shortcut moves a line with its block, which saves in the new order', async ({
    page,
  }) => {
    const editor = await openSourceMode(page)
    await caretAtEnd(page, editor, CREATE)

    await page.keyboard.press('ControlOrMeta+Shift+ArrowUp')

    expect(await bufferIds(editor)).toEqual([GS1, GS3, GS2, GS4, GS5])
    await editor.press('ControlOrMeta+s')
    await expect(sourceEditor(page)).toHaveCount(0)
    await reopenPage(page, PAGE)
    await expect.poll(() => blockIds(page)).toEqual([GS1, GS3, GS2, GS4, GS5])
  })

  test('[[ picks a page, written as [[Title]], which saves as a link to it', async ({ page }) => {
    const editor = await openSourceMode(page)
    await caretAtEnd(page, editor, WELCOME)

    await page.keyboard.type(' [[Quick')
    const option = activeSuggestionList(page).getByRole('option', { name: /Quick Notes/ })
    await expect(option).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Enter')

    await expect(activeSuggestionPopup(page)).toHaveCount(0)
    await expect(sourceLine(editor, WELCOME)).toHaveText(
      'Welcome to Agaric! This is your personal knowledge base. [[Quick Notes]]',
    )
    await editor.press('ControlOrMeta+s')
    await expect(sourceEditor(page)).toHaveCount(0)
    await expect(staticBlock(page, GS1)).toContainText('Quick Notes')
  })

  test('Changes marks what an edit added, Preview shows its link as a chip, and Save keeps it', async ({
    page,
  }) => {
    const editor = await openSourceMode(page)
    await caretAtEnd(page, editor, WELCOME)
    await page.keyboard.type(' See [[Quick Notes]] now.')
    await expect(saveButton(page)).toHaveText('Save (1 change)')

    await page.getByRole('tab', { name: 'Changes', exact: true }).click()
    const changes = page.getByRole('region', { name: 'Changes', exact: true })
    await expect(editor).toBeHidden()
    await expect(changes.locator('[data-change="removed"]')).toHaveText([
      '−Removed: Welcome to Agaric! This is your personal knowledge base.',
    ])
    await expect(changes.locator('mark')).toHaveText(['See [[Quick Notes]] now.'])

    await page.getByRole('tab', { name: 'Preview', exact: true }).click()
    const preview = page.getByRole('region', { name: 'Preview', exact: true })
    const first = preview.getByTestId('page-source-preview-block').first()
    await expect(first.getByTestId('block-link-chip')).toHaveText('Quick Notes')
    await expect(first).toContainText('now.')
    await expect(first).not.toContainText('[[')

    await saveButton(page).click()
    await expect(sourceEditor(page)).toHaveCount(0)
    await reopenPage(page, PAGE)
    await expect(staticBlock(page, GS1).getByTestId('block-link-chip')).toHaveText('Quick Notes')
    await expect(staticBlock(page, GS1)).toContainText('knowledge base. See Quick Notes now.')
  })

  test('the toolbar’s Turn into makes the line at the cursor a heading, which saves as one', async ({
    page,
  }) => {
    const editor = await openSourceMode(page)
    await caretAtEnd(page, editor, WELCOME)

    await toolbarButton(page, 'Turn into').click()
    await activePopover(page).getByRole('menuitemradio', { name: 'Heading 1' }).click()

    await expect(sourceLine(editor, WELCOME)).toHaveText(
      '# Welcome to Agaric! This is your personal knowledge base.',
    )
    await editor.press('ControlOrMeta+s')
    await expect(sourceEditor(page)).toHaveCount(0)
    await expect(staticBlock(page, GS1).locator('h1')).toContainText(WELCOME)
  })

  test('a heading chord makes the line at the cursor that heading, which stays', async ({
    page,
  }) => {
    const editor = await openSourceMode(page)
    await caretAtEnd(page, editor, WELCOME)

    await page.keyboard.press('Control+Alt+2')

    await expect(sourceLine(editor, WELCOME)).toHaveText(
      '## Welcome to Agaric! This is your personal knowledge base.',
    )
    await editor.press('ControlOrMeta+s')
    await expect(sourceEditor(page)).toHaveCount(0)
    await reopenPage(page, PAGE)
    await expect(staticBlock(page, GS1).locator('h2')).toContainText(WELCOME)
  })

  test('the block-menu button moves the block at the cursor, which saves in the new order', async ({
    page,
  }) => {
    const editor = await openSourceMode(page)
    await caretAtEnd(page, editor, CREATE)

    await toolbarButton(page, 'Block actions').click()
    const menu = activeMenu(page)
    await menu.getByRole('menuitem', { name: /^Move & arrange/ }).click()
    await menu.getByRole('menuitem', { name: /^Move Up/ }).click()

    await expect(menu).toHaveCount(0)
    await expect(editor).toBeFocused()
    expect(await bufferIds(editor)).toEqual([GS1, GS3, GS2, GS4, GS5])
    await editor.press('ControlOrMeta+s')
    await expect(sourceEditor(page)).toHaveCount(0)
    await reopenPage(page, PAGE)
    await expect.poll(() => blockIds(page)).toEqual([GS1, GS3, GS2, GS4, GS5])
  })
})

test.describe('Edit as Markdown writes a page line by line (#5691) @editor @pages @markdown', () => {
  test('each kind of block shows as its line, and a `- item` typed saves as a bullet block', async ({
    page,
  }) => {
    await waitForBoot(page)
    const title = 'Line by line'
    const pageId = await ipc<string>(page, 'create_page_in_space', {
      parentId: null,
      content: title,
      spaceId: 'SPACE_PERSONAL',
    })
    const [heading, bullet, numbered, task, plain] = await seedSearchBlocks(page, [
      { content: '## Plan', parentId: pageId },
      { content: 'buy milk', parentId: pageId, props: { listStyle: 'bullet' } },
      { content: 'first step', parentId: pageId, props: { listStyle: 'ordered' } },
      { content: 'call the bank', parentId: pageId, todo: 'TODO' },
      { content: 'Just a note.', parentId: pageId },
    ])
    await openPage(page, title)
    const editor = await openSourceMode(page, 'Just a note.')

    expect(await bufferLines(editor)).toEqual([
      ['## Plan', heading],
      ['', null],
      ['- buy milk', bullet],
      ['1. first step', numbered],
      ['- [ ] call the bank', task],
      ['', null],
      ['Just a note.', plain],
      ['', null],
    ])
    await caretAtEnd(page, editor, 'buy milk')
    await page.keyboard.press('Enter')
    await page.keyboard.type('new item')
    expect((await bufferLines(editor)).slice(2, 4)).toEqual([
      ['- buy milk', bullet],
      ['- new item', null],
    ])
    await editor.press('ControlOrMeta+s')
    await expect(sourceEditor(page)).toHaveCount(0)

    await reopenPage(page, title)
    await expect.poll(async () => (await blockIds(page)).length).toBe(6)
    const ids = await blockIds(page)
    expect([ids[0], ids[1], ids[3], ids[4], ids[5]]).toEqual([
      heading,
      bullet,
      numbered,
      task,
      plain,
    ])
    const added = ids[2] as string
    await expect(staticBlock(page, added)).toHaveText(/new item$/)
    await expect(staticBlock(page, added).getByTestId('list-marker')).toBeVisible()
    const rows = await ipc<Array<{ key: string; value_text: string | null }>>(
      page,
      'get_properties',
      { blockId: added },
    )
    expect(rows.find((row) => row.key === 'listStyle')?.value_text).toBe('bullet')
    expect((await bufferLines(await openSourceMode(page, 'new item'))).slice(2, 4)).toEqual([
      ['- buy milk', bullet],
      ['- new item', added],
    ])
  })
})

test.describe('Edit as Markdown on a 390 px phone @editor @pages @markdown @mobile', () => {
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

  test('the toolbar carries New line, Cancel and Save on screen, and Save saves', async ({
    page,
  }) => {
    await waitForBoot(page)
    await openPageMobile(page, PAGE)
    const editor = await openSourceMode(page)

    await expect(toolbarButton(page, 'New line')).toBeInViewport()
    await expect(toolbarButton(page, 'Cancel')).toBeInViewport({ ratio: 1 })
    const save = toolbarButton(page, SAVE)
    await expect(save).toBeInViewport({ ratio: 1 })
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(1)

    await caretAtEnd(page, editor, WELCOME)
    await page.keyboard.type(' Typed on a phone.')
    await save.click()

    await expect(sourceEditor(page)).toHaveCount(0)
    await expect(staticBlock(page, GS1)).toContainText('knowledge base. Typed on a phone.')
  })

  test('Cancel on the toolbar asks first when the buffer changed', async ({ page }) => {
    await waitForBoot(page)
    await openPageMobile(page, PAGE)
    const editor = await openSourceMode(page)
    await caretAtEnd(page, editor, WELCOME)
    await page.keyboard.type(' Not kept.')

    await toolbarButton(page, 'Cancel').click()
    await activeSheet(page).getByRole('button', { name: 'Discard', exact: true }).click()

    await expect(sourceEditor(page)).toHaveCount(0)
    await expect(staticBlock(page, GS1)).not.toContainText('Not kept.')
  })
})
