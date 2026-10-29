/**
 * The switch between page mode and Edit as Markdown (#5691), as GitLab's "Switch to plain text
 * editing" and back: page mode's footer opens the buffer, and the buffer's Page link (or Ctrl+E)
 * saves what changed and opens page mode on it, from block mode too. Plain text only: the
 * Document buffer's list markers, checkboxes and property lines are pinned by the conformance
 * fixture `apply_page_source_document.json` and by `e2e-tauri/page-source-document.e2e.ts`.
 */

import type { Locator, Page } from '@playwright/test'

import {
  expect,
  getInvokeCalls,
  installIpcRecorder,
  ipc,
  reopenPage,
  test,
  waitForBoot,
} from './helpers'

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const EDITOR = '[data-testid="page-mode-editor"]'

interface Shown {
  id: string
  text: string
}

/** A page titled `title` holding one top-level block per text; resolves its id. */
async function seedPage(page: Page, title: string, texts: readonly string[]): Promise<string> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SCOPE.space_id,
  })
  for (const content of texts) {
    await ipc(page, 'create_block', {
      blockType: 'content',
      content,
      parentId: pageId,
      index: null,
      scope: SCOPE,
    })
  }
  return pageId
}

function pageModeSwitch(page: Page): Locator {
  return page.getByRole('radiogroup', { name: 'Editing mode' }).getByRole('radio', { name: 'Page' })
}

async function toPageMode(page: Page, count: number): Promise<void> {
  await pageModeSwitch(page).click()
  await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(count)
}

async function openPage(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Control+k')
  await page.locator('[cmdk-input]').first().fill(title)
  await page.locator('[cmdk-item]').filter({ hasText: title }).first().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
}

/** The page-mode document as shown: each block's id and text. */
function shown(page: Page): Promise<Shown[]> {
  return page.locator(`${EDITOR} [data-page-block]`).evaluateAll((els) =>
    els.map((el) => ({
      id: el.getAttribute('data-page-block-id') ?? '',
      text: el.querySelector('.page-block-content')?.textContent ?? '',
    })),
  )
}

/** The page as the backend holds it now: its top-level blocks' text, in order. */
async function backendTexts(page: Page, pageId: string): Promise<string[]> {
  const { blocks } = await ipc<{
    blocks: Array<{ parent_id: string; position: number; content: string | null }>
  }>(page, 'load_page_subtree', { rootBlockId: pageId, scope: SCOPE })
  return blocks
    .filter((b) => b.parent_id === pageId)
    .toSorted((a, b) => a.position - b.position)
    .map((b) => b.content ?? '')
}

/** The buffer, once it shows `shows` and has the focus. */
async function focusedBuffer(page: Page, shows: string): Promise<Locator> {
  const buffer = page.getByRole('textbox', { name: 'Markdown source', exact: true })
  await expect(buffer).toContainText(shows)
  // ProseMirror writes its own selection back over the DOM's just after a focus.
  await expect(buffer).toBeFocused()
  return buffer
}

/** Page mode's footer link to Edit as Markdown; resolves the buffer, focused. */
async function openMarkdownFromFooter(page: Page, shows: string): Promise<Locator> {
  await page.getByRole('button', { name: 'Edit as Markdown', exact: true }).click()
  return focusedBuffer(page, shows)
}

/** The page kebab's Edit as Markdown, from block mode; resolves the buffer, focused. */
async function openMarkdownFromKebab(page: Page, shows: string): Promise<Locator> {
  await page.getByRole('button', { name: 'Page actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Edit as Markdown', exact: true }).click()
  return focusedBuffer(page, shows)
}

/** The caret at the end of the buffer line holding `text`, once the editor has read it. */
async function caretAtEndOfLine(page: Page, buffer: Locator, text: string): Promise<void> {
  await buffer.locator('[data-source-line]', { hasText: text }).click({ clickCount: 3 })
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(() => {
    const dom = document.querySelector('[data-testid="page-source-editor"]') as HTMLElement & {
      editor: { state: { selection: { empty: boolean } } }
    }
    return dom.editor.state.selection.empty
  })
}

function backToPage(page: Page): Locator {
  return page.getByRole('button', { name: 'Page', exact: true })
}

test.describe('page mode and Edit as Markdown switch both ways (#5691) @editor @pages @markdown', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a line edited in Markdown opened from blocks is saved by the Page link, and page mode shows it, after leaving too', async ({
    page,
  }) => {
    const title = 'Footer switch edit'
    const pageId = await seedPage(page, title, ['alpha', 'beta', 'gamma'])
    await openPage(page, title)
    const buffer = await openMarkdownFromKebab(page, 'beta')

    await caretAtEndOfLine(page, buffer, 'beta')
    await page.keyboard.type(' edited')
    await expect(buffer).toContainText('beta edited')
    await backToPage(page).click()

    await expect(buffer).toBeHidden()
    await expect
      .poll(async () => (await shown(page)).map((b) => b.text))
      .toEqual(['alpha', 'beta edited', 'gamma'])
    await expect(page.locator(EDITOR)).toBeFocused()
    expect(await backendTexts(page, pageId)).toEqual(['alpha', 'beta edited', 'gamma'])
    await reopenPage(page, title)
    await toPageMode(page, 3)
    expect((await shown(page)).map((b) => b.text)).toEqual(['alpha', 'beta edited', 'gamma'])
  })

  test('Ctrl+E with nothing changed in Markdown writes nothing, and the page is as it was', async ({
    page,
  }) => {
    const title = 'Footer switch unchanged'
    await seedPage(page, title, ['one', 'two', 'three'])
    await openPage(page, title)
    await toPageMode(page, 3)
    const before = await shown(page)
    await installIpcRecorder(page)
    const buffer = await openMarkdownFromFooter(page, 'two')

    await page.keyboard.press('Control+e')

    await expect(buffer).toBeHidden()
    await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(3)
    await expect(page.locator(EDITOR)).toBeFocused()
    expect(await shown(page)).toEqual(before)
    expect(await getInvokeCalls(page, 'apply_page_source')).toEqual([])
    expect(await getInvokeCalls(page, 'edit_block')).toEqual([])
    await reopenPage(page, title)
    await toPageMode(page, 3)
    expect(await shown(page)).toEqual(before)
  })
})
