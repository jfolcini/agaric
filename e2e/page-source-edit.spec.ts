import type { Locator, Page } from '@playwright/test'
import { devices } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
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
  pasteText,
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
 * reloaded. The Rust tests own the grammar. The file runs on the mock and on
 * the real backend through the bridge; the names the buffer writes for refs
 * and labels are the backend's alone (`@real-only`).
 */

const PAGE = 'Getting Started'
const GS1 = '0000000000000000000B10CK01'
const GS2 = '0000000000000000000B10CK02'
const GS3 = '0000000000000000000B10CK03'
const GS4 = '0000000000000000000B10CK04'
const GS5 = '0000000000000000000B10CK05'
const WELCOME = 'Welcome to Agaric!'
const HELLO_LINE = 'Hello, Agaric! This is your personal knowledge base.'
const CREATE = 'Create new blocks'
const SEARCH = 'Use the search panel'
const NOTES = 'Quick Notes'
const QN1 = '0000000000000000000B10CK08'
const QN2 = '0000000000000000000B10CK09'
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

    // Both edits are stored, once each.
    await reopenPage(page, PAGE)
    await expect(staticBlock(page, GS1)).toContainText('Hello, Agaric!')
    await expect(staticBlock(page, GS3)).toHaveText(elsewhere)
    await expect(page.getByText(CREATE)).toHaveCount(0)
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
    // A plain child is a `+` item (decision 2, #6277).
    expect(indented[second]?.[0]).toMatch(/^ {2}\+ Use the sidebar/)
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
    await menu.getByRole('menuitem', { name: /^Move up/ }).click()

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
      spaceId: SEED_IDS.SPACE_PERSONAL,
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

  test('Enter under a nested paragraph makes its sibling, which saves under the same parent', async ({
    page,
  }) => {
    await waitForBoot(page)
    const title = 'Nested Enter'
    const pageId = await ipc<string>(page, 'create_page_in_space', {
      parentId: null,
      content: title,
      spaceId: SEED_IDS.SPACE_PERSONAL,
    })
    const [parent] = await seedSearchBlocks(page, [{ content: 'Parent note', parentId: pageId }])
    const [child] = await seedSearchBlocks(page, [
      { content: 'Child note', parentId: parent as string },
    ])
    await openPage(page, title)
    const editor = await openSourceMode(page, 'Child note')

    await caretAtEnd(page, editor, 'Child note')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Sibling note')
    // A plain child is a `+` item, its sibling one more with no blank line (decision 2, #6277).
    await expect
      .poll(async () => (await bufferLines(editor)).slice(0, 4))
      .toEqual([
        ['Parent note', parent],
        ['', null],
        ['  + Child note', child],
        ['  + Sibling note', null],
      ])
    await editor.press('ControlOrMeta+s')
    await expect(sourceEditor(page)).toHaveCount(0)

    await reopenPage(page, title)
    await expect.poll(async () => (await blockIds(page)).length).toBe(3)
    const [, shown, added] = await blockIds(page)
    expect(shown).toBe(child)
    await expect(staticBlock(page, added as string)).toHaveText('Sibling note')
    const parentOf = async (blockId: string) =>
      (await ipc<{ parent_id: string | null }>(page, 'get_block', { blockId })).parent_id
    expect(await parentOf(added as string)).toBe(parent)
    expect(await parentOf(child as string)).toBe(parent)
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

  test('the page menu keeps its rows in place while it closes', async ({ page }) => {
    await waitForBoot(page)
    await openPageMobile(page, PAGE)
    await pageActions(page).click()
    const editSource = page.getByRole('menuitem', { name: 'Edit as Markdown', exact: true })
    await expect(editSource).toBeVisible()
    // Its rows overflow this screen: a click while the sheet still slides in
    // scrolls them to reach the row, so the slide ends first.
    await activeSheet(page).evaluate((sheet) =>
      Promise.all(sheet.getAnimations().map((slide) => slide.finished)),
    )
    // The row may sit below the fold of the sheet, and the click's own scroll
    // to it is not the movement under test.
    await editSource.scrollIntoViewIfNeeded()
    // Every frame from the click until the sheet has left: its rows, each with
    // its offset from the sheet's top, so the slide itself does not count.
    await page.evaluate(() => {
      const frames: string[][] = []
      Object.assign(window, { closingRows: frames })
      const sample = () => {
        const sheet = document.querySelector('[data-slot="sheet-content"]')
        if (sheet == null) return
        const top = sheet.getBoundingClientRect().top
        frames.push(
          [...sheet.querySelectorAll('[role="menuitem"]')].map(
            (row) => `${row.textContent} @${Math.round(row.getBoundingClientRect().top - top)}`,
          ),
        )
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
    await editSource.click()
    await expect(page.getByRole('menu', { name: 'Page actions', exact: true })).toHaveCount(0)

    const frames = await page.evaluate(
      () => (window as unknown as { closingRows: string[][] }).closingRows,
    )
    // The first frame is the open menu; how many follow depends on the frame rate.
    const [open, ...closing] = frames
    expect(open?.some((row) => row.startsWith('Edit as Markdown'))).toBe(true)
    expect(closing.length).toBeGreaterThan(0)
    for (const frame of closing) expect(frame).toEqual(open)
  })

  test('a tap on the buffer while the page menu closes reaches the buffer', async ({ page }) => {
    await waitForBoot(page)
    await openPageMobile(page, PAGE)
    await pageActions(page).click()
    const editSource = page.getByRole('menuitem', { name: 'Edit as Markdown', exact: true })
    await expect(editSource).toBeVisible()
    await activeSheet(page).evaluate((sheet) =>
      Promise.all(sheet.getAnimations().map((slide) => slide.finished)),
    )
    // On a busy main thread the closed sheet's exit starts late, so it still
    // sits where it was open when the next tap comes. Freezing every animation
    // holds it there.
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Animation.enable')
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 0 })
    await editSource.click()
    const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
    await expect(editor).toContainText(WELCOME)
    await expect(editor).toBeFocused()

    // The closed menu's sheet lies over the middle of the line.
    const line = await sourceLine(editor, WELCOME).boundingBox()
    const sheet = await activeSheet(page).boundingBox()
    if (line === null || sheet === null) throw new Error('the line or the closed sheet has no box')
    const x = line.x + line.width / 2
    const y = line.y + line.height / 2
    expect(y > sheet.y && y < sheet.y + sheet.height).toBe(true)

    // A finger's tap there, with none of Playwright's waits for the point to clear.
    await page.mouse.click(x, y)
    await expect
      .poll(() =>
        page.evaluate(() => {
          const at = window.getSelection()?.anchorNode
          const element = at instanceof Element ? at : at?.parentElement
          return element?.closest('[data-source-line]')?.textContent ?? ''
        }),
      )
      .toContain(WELCOME)
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

/** A page titled `title` holding `contents` as top-level blocks, opened; resolves their ids. */
async function seedOpenPage(page: Page, title: string, contents: string[]): Promise<string[]> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SEED_IDS.SPACE_PERSONAL,
  })
  const ids = await seedSearchBlocks(
    page,
    contents.map((content) => ({ content, parentId: pageId })),
  )
  await openPage(page, title)
  await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(contents.length)
  return ids
}

/** Select from the start of buffer line `from` to the start of line `to`, as a drag would. */
async function selectLines(page: Page, from: number, to: number): Promise<void> {
  await page.evaluate(
    ({ first, last }) => {
      const dom = document.querySelector('[data-testid="page-source-editor"]') as HTMLElement & {
        editor: {
          state: { doc: { forEach: (f: (node: unknown, offset: number) => void) => void } }
          commands: { setTextSelection: (range: { from: number; to: number }) => boolean }
        }
      }
      const starts: number[] = []
      dom.editor.state.doc.forEach((_node, offset) => starts.push(offset + 1))
      dom.editor.commands.setTextSelection({ from: starts[first] ?? 0, to: starts[last] ?? 0 })
    },
    { first: from, last: to },
  )
}

/** The index of the buffer line whose text is `text`. */
async function lineIndex(editor: Locator, text: string): Promise<number> {
  const index = (await bufferLines(editor)).findIndex(([line]) => line === text)
  if (index === -1) throw new Error(`no buffer line reads ${text}`)
  return index
}

/** Save with Ctrl+S and wait for the buffer to close. */
async function saveSource(page: Page, editor: Locator): Promise<void> {
  await editor.press('ControlOrMeta+s')
  await expect(sourceEditor(page)).toHaveCount(0)
}

test.describe('Edit as Markdown, as the backend reads it back (#6926) @editor @pages @markdown', () => {
  test.beforeEach(async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await waitForBoot(page)
  })

  test('a paragraph cut and pasted elsewhere moves its block with its child', async ({ page }) => {
    const [first, second, third] = await seedOpenPage(page, 'Cut move', [
      'First para',
      'Second para',
      'Third para',
    ])
    const [child] = await seedSearchBlocks(page, [
      { content: 'Child para', parentId: first as string },
    ])
    await reopenPage(page, 'Cut move')
    await expect.poll(() => blockIds(page)).toEqual([first, child, second, third])

    const editor = await openSourceMode(page, 'Child para')
    // The first paragraph and its child's lines, to where the second starts.
    await selectLines(
      page,
      await lineIndex(editor, 'First para'),
      await lineIndex(editor, 'Second para'),
    )
    await page.keyboard.press('ControlOrMeta+x')
    await selectLine(editor, 'Third para')
    await moveSelection(page, 'ArrowLeft')
    await page.keyboard.press('ControlOrMeta+v')
    await saveSource(page, editor)

    await reopenPage(page, 'Cut move')
    await expect.poll(() => blockIds(page)).toEqual([second, first, child, third])
    await expect(
      page.locator(`li[aria-level="2"] [data-testid="sortable-block"][data-block-id="${child}"]`),
    ).toHaveCount(1)
  })

  test('a paragraph copied and pasted saves as a new block beside the original', async ({
    page,
  }) => {
    const [first, second] = await seedOpenPage(page, 'Copy paste', ['Copied para', 'Last para'])
    const editor = await openSourceMode(page, 'Last para')
    const copied = await lineIndex(editor, 'Copied para')
    await selectLines(page, copied, copied + 2)
    await page.keyboard.press('ControlOrMeta+c')
    await selectLine(editor, 'Last para')
    await moveSelection(page, 'ArrowLeft')
    await page.keyboard.press('ControlOrMeta+v')
    await saveSource(page, editor)

    await reopenPage(page, 'Copy paste')
    await expect.poll(async () => (await blockIds(page)).length).toBe(3)
    const [original, copy, last] = await blockIds(page)
    expect([original, last]).toEqual([first, second])
    expect([first, second]).not.toContain(copy)
    await expect(staticBlock(page, copy as string)).toHaveText('Copied para')
  })

  test('a property line sets, edits and, left empty, deletes the property', async ({ page }) => {
    const [block] = await seedOpenPage(page, 'Property lines', ['Prop marker'])
    const chip = (value: string) => page.getByTestId('property-chip').filter({ hasText: value })

    let editor = await openSourceMode(page, 'Prop marker')
    await caretAtEnd(page, editor, 'Prop marker')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('  srckey:: first value')
    await saveSource(page, editor)
    await reopenPage(page, 'Property lines')
    await expect(chip('first value')).toBeVisible()
    await expect(staticBlock(page, block as string)).toHaveText('Prop marker')

    editor = await openSourceMode(page, 'srckey:: first value')
    await selectLine(editor, 'srckey:: first value')
    await page.keyboard.type('  srckey:: second value')
    await saveSource(page, editor)
    await reopenPage(page, 'Property lines')
    await expect(chip('second value')).toBeVisible()
    await expect(chip('first value')).toHaveCount(0)

    editor = await openSourceMode(page, 'srckey:: second value')
    await selectLine(editor, 'srckey:: second value')
    await page.keyboard.type('  srckey::')
    await saveSource(page, editor)
    await reopenPage(page, 'Property lines')
    await expect(staticBlock(page, block as string)).toHaveText('Prop marker')
    await expect(chip('second value')).toHaveCount(0)
    // The buffer re-reads the page: a property still stored, or the emptied line kept as text,
    // would be a line of it.
    editor = await openSourceMode(page, 'Prop marker')
    await expect(editor).not.toContainText('srckey')
  })

  test('a refused repeat rule blocks the save, names its line and writes nothing', async ({
    page,
  }) => {
    const [block] = await seedOpenPage(page, 'Refused rule', ['Rule marker'])
    let editor = await openSourceMode(page, 'Rule marker')
    // The same save edits the text too, so a save that wrote part of itself before refusing shows.
    await caretAtEnd(page, editor, 'Rule marker')
    await page.keyboard.type(' edited')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('  repeat:: every tuesday')
    await editor.press('ControlOrMeta+s')

    const refusal = page.locator('p[role="alert"]').filter({ hasText: 'repeat:: every tuesday' })
    await expect(refusal).toHaveText(/^line \d+: /)
    await expect(sourceEditor(page)).toBeVisible()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await activeAlertDialog(page).getByRole('button', { name: 'Discard', exact: true }).click()
    await expect(sourceEditor(page)).toHaveCount(0)

    await reopenPage(page, 'Refused rule')
    await expect(staticBlock(page, block as string)).toHaveText('Rule marker')
    editor = await openSourceMode(page, 'Rule marker')
    await expect(editor).not.toContainText('repeat::')
  })

  test('a page of every kind of block saves back unchanged, and a `-` restyled `1.` saves numbered', async ({
    page,
  }) => {
    const LONE = 'lone bullet'
    const KINDS = [
      '## Plan',
      '',
      'Intro line one',
      'intro line two',
      '',
      '- bullet item',
      '  + plain child',
      `- ${LONE}`,
      '1. first step',
      '2. second step',
      '- [ ] call the bank',
      '  priority:: 1',
      '- [x] done already',
      '',
      '> a quote',
      '',
      '```sh',
      'echo hi',
      '```',
      '',
      'parent paragraph',
      '',
      '  child paragraph',
    ]
    const [marker] = await seedOpenPage(page, 'Every kind', ['Kinds marker'])
    const pageId = (await ipc<{ parent_id: string }>(page, 'get_block', { blockId: marker }))
      .parent_id
    let editor = await openSourceMode(page, 'Kinds marker')
    await caretAtEnd(page, editor, 'Kinds marker')
    await page.keyboard.press('Enter')
    await pasteText(editor, KINDS.join('\n'))
    await saveSource(page, editor)

    interface Row {
      id: string
      parent_id: string | null
      position: number | null
      content: string | null
      todo_state: string | null
      priority: string | null
    }
    /** The page's blocks depth-first: depth, text, list style, task and priority, as stored. */
    const storedKinds = async () => {
      const { blocks } = await ipc<{ blocks: Row[] }>(page, 'load_page_subtree', {
        rootBlockId: pageId,
        scope: { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL },
      })
      const props = await ipc<Record<string, Array<{ key: string; value_text: string | null }>>>(
        page,
        'get_batch_properties',
        { blockIds: blocks.map((b) => b.id) },
      )
      const out: unknown[] = []
      const walk = (parentId: string, depth: number): void => {
        const children = blocks
          .filter((b) => b.parent_id === parentId)
          .toSorted((a, b) => (a.position ?? 0) - (b.position ?? 0))
        for (const b of children) {
          const style = props[b.id]?.find((row) => row.key === 'listStyle')?.value_text ?? null
          out.push([depth, b.content, style, b.todo_state, b.priority])
          walk(b.id, depth + 1)
        }
      }
      walk(pageId, 0)
      return out
    }
    const history = async () =>
      (
        await ipc<{ items: unknown[] }>(page, 'list_page_history', {
          pageId,
          opTypeFilter: null,
          scope: { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL },
          cursor: null,
          limit: 50,
        })
      ).items

    const built = [
      [0, 'Kinds marker', null, null, null],
      [0, '## Plan', null, null, null],
      [0, 'Intro line one\nintro line two', null, null, null],
      [0, 'bullet item', 'bullet', null, null],
      [1, 'plain child', null, null, null],
      [0, LONE, 'bullet', null, null],
      [0, 'first step', 'ordered', null, null],
      [0, 'second step', 'ordered', null, null],
      [0, 'call the bank', null, 'TODO', '1'],
      [0, 'done already', null, 'DONE', null],
      [0, '> a quote', null, null, null],
      [0, '```sh\necho hi\n```', null, null, null],
      [0, 'parent paragraph', null, null, null],
      [1, 'child paragraph', null, null, null],
    ]
    await expect.poll(storedKinds).toEqual(built)

    // Nothing the page holds changes, one more blank line under the heading: the backend reads
    // back the tree it wrote, so the save appends no op.
    await reopenPage(page, 'Every kind')
    const before = await history()
    editor = await openSourceMode(page, LONE)
    const heading = await lineIndex(editor, '## Plan')
    await editor
      .locator('[data-source-line]')
      .nth(heading + 1)
      .click()
    await page.keyboard.press('Shift+Enter')
    await saveSource(page, editor)
    await reopenPage(page, 'Every kind')
    expect(await storedKinds()).toEqual(built)
    expect(await history()).toEqual(before)

    // One restyle: the lone bullet's `-` becomes `1.`, and joins the numbered run after it.
    editor = await openSourceMode(page, LONE)
    await selectLine(editor, `- ${LONE}`)
    await page.keyboard.type(`1. ${LONE}`)
    await saveSource(page, editor)
    await reopenPage(page, 'Every kind')
    await expect
      .poll(storedKinds)
      .toEqual(built.map((kind) => (kind[1] === LONE ? [0, LONE, 'ordered', null, null] : kind)))
    editor = await openSourceMode(page, LONE)
    const lone = await lineIndex(editor, `1. ${LONE}`)
    expect((await bufferLines(editor)).slice(lone, lone + 3).map(([text]) => text)).toEqual([
      `1. ${LONE}`,
      '2. first step',
      '3. second step',
    ])
  })
})

/**
 * Only the real backend writes names in the buffer and reads them back on save
 * (`get_page_buffer` / `apply_page_source`); the mock's buffer keeps raw ids.
 */
test.describe(
  'Edit as Markdown writes refs and labels by name (#6277, #5160 D9) @editor @markdown',
  { tag: '@real-only' },
  () => {
    test.beforeEach(async ({ page }) => {
      await waitForBoot(page)
    })

    test('a labelled link reads as [[Page|label]], and an edited label is stored', async ({
      page,
    }) => {
      const [block] = await seedOpenPage(page, 'Labelled', [
        `see [[${SEED_IDS.PAGE_QUICK_NOTES}|the notes]]`,
      ])
      const editor = await openSourceMode(page, 'see')
      await expect(editor).toContainText('see [[Quick Notes|the notes]]')
      await selectLine(editor, 'see [[Quick Notes|the notes]]')
      await page.keyboard.type('see [[Quick Notes|my notes]]')
      await saveSource(page, editor)

      await reopenPage(page, 'Labelled')
      const chip = staticBlock(page, block as string).getByTestId('block-link-chip')
      await expect(chip).toHaveText('my notes')
      await expect(chip).toHaveAttribute('title', 'Quick Notes')
    })

    test('a ref to a block of another page reads as [[Title#^id]], and saves back as that ref', async ({
      page,
    }) => {
      const [target] = await seedOpenPage(page, 'Ref target page', ['Target block'])
      const [ref] = await seedOpenPage(page, 'Ref source', [`Ref line ((${target}))`])
      const link = `[[Ref target page#^${target}]]`
      const editor = await openSourceMode(page, 'Ref line')
      await expect(editor).toContainText(`Ref line ${link}`)
      await caretAtEnd(page, editor, 'Ref line')
      await page.keyboard.type(' edited')
      await saveSource(page, editor)

      await reopenPage(page, 'Ref source')
      await expect(staticBlock(page, ref as string).getByTestId('block-ref-chip')).toBeVisible()
      expect((await ipc<{ content: string }>(page, 'get_block', { blockId: ref })).content).toBe(
        `Ref line ((${target})) edited`,
      )
    })

    test('a ref to a unique heading reads as [[Title#Heading]], saves back, and exports the heading bare', async ({
      page,
    }) => {
      const [heading] = await seedOpenPage(page, 'Heading page', ['## Unique heading'])
      const headingPage = (
        await ipc<{ parent_id: string }>(page, 'get_block', { blockId: heading })
      ).parent_id
      const [ref] = await seedOpenPage(page, 'Heading ref', [`Heading ref ((${heading}))`])
      const link = '[[Heading page#Unique heading]]'
      const editor = await openSourceMode(page, 'Heading ref')
      await expect(editor).toContainText(`Heading ref ${link}`)
      await caretAtEnd(page, editor, 'Heading ref')
      await page.keyboard.type(' edited')
      await saveSource(page, editor)

      await reopenPage(page, 'Heading ref')
      await expect(staticBlock(page, ref as string).getByTestId('block-ref-chip')).toBeVisible()
      expect((await ipc<{ content: string }>(page, 'get_block', { blockId: ref })).content).toBe(
        `Heading ref ((${heading})) edited`,
      )
      // The export, which Obsidian reads, names the heading by its text: no block id on its line.
      const exported = await ipc<string>(page, 'export_page_markdown', { pageId: headingPage })
      expect(exported.split('\n')).toContain('## Unique heading')
    })
  },
)
