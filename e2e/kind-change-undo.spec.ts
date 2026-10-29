import type { Page } from '@playwright/test'

import { runSlashCommand } from './domain'
import {
  activeSuggestionPopup,
  blurEditors,
  expect,
  focusBlockById,
  ipc,
  saveBlock,
  test,
  waitForBoot,
} from './helpers'

/**
 * An edit that changes a block's kind is one undo step with the kind it took
 * off (#6156): Ctrl+Z after a bulleted block was made a heading or a task, or
 * a task made bulleted, brings back the text, the bullet and the task state it
 * had, and leaves the edit made before. In block mode and in page mode, each
 * checked after navigating away and back, against what the backend holds.
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

interface Kind {
  text: string
  listStyle: string | null
  todo: string | null
}

/** A page of four blocks: `alpha` and `beta` bulleted, `gamma` a task, and a plain `delta`. */
async function seed(page: Page, title: string): Promise<string[]> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SCOPE.space_id,
  })
  const ids: string[] = []
  for (const content of ['alpha', 'beta', 'gamma', 'delta']) {
    const row = await ipc<{ id: string }>(page, 'create_block', {
      blockType: 'content',
      content,
      parentId: pageId,
      index: null,
      scope: SCOPE,
    })
    ids.push(row.id)
  }
  for (const id of ids.slice(0, 2)) {
    await ipc(page, 'set_property', { blockId: id, key: 'listStyle', value: BULLET })
  }
  await ipc(page, 'set_todo_state', { blockId: ids[2], state: 'TODO' })
  return ids
}

/** What the backend holds of block `blockId`'s kind: its text, list style and task state. */
async function kindOf(page: Page, blockId: string): Promise<Kind> {
  const row = await ipc<{ content: string; todo_state: string | null }>(page, 'get_block', {
    blockId,
  })
  const props = await ipc<Array<{ key: string; value_text: string | null }>>(
    page,
    'get_properties',
    { blockId },
  )
  return {
    text: row.content.trimEnd(),
    listStyle: props.find((p) => p.key === 'listStyle')?.value_text ?? null,
    todo: row.todo_state,
  }
}

async function openViaPalette(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Escape')
  await expect
    .poll(() => page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, EDITOR))
    .toBe(false)
  await page.keyboard.press('Control+k')
  await page.locator('[cmdk-input]').first().fill(title)
  await page.locator('[cmdk-item]').filter({ hasText: title }).first().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
  await expect(page.getByTestId('view-transition-wrapper')).toHaveCSS('opacity', '1')
}

async function openInPageMode(page: Page, title: string): Promise<void> {
  await openViaPalette(page, title)
  await page
    .getByRole('radiogroup', { name: 'Editing mode' })
    .getByRole('radio', { name: 'Page' })
    .click()
  await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(4)
}

/** Put page mode's caret at the end of block `index`'s text. */
function caretAtEnd(page: Page, index: number): Promise<unknown> {
  return page.evaluate(
    ({ selector, i }) => {
      const { editor } = document.querySelector(selector) as HTMLElement & {
        editor: {
          state: { doc: { child: (n: number) => { nodeSize: number } } }
          commands: { setTextSelection: (pos: number) => boolean }
          view: { focus: () => void }
        }
      }
      let pos = 0
      for (let k = 0; k <= i; k += 1) pos += editor.state.doc.child(k).nodeSize
      editor.commands.setTextSelection(pos - 2)
      editor.view.focus()
      return new Promise((resolve) => setTimeout(resolve, 20))
    },
    { selector: EDITOR, i: index },
  )
}

/** A page-level Ctrl+Z, with no editor focused, once it has run. */
async function pageUndo(page: Page): Promise<void> {
  await blurEditors(page)
  await page.keyboard.press('Control+z')
  await expect(page.getByLabel('Notifications alt+T').getByText(/Und(one|id)/)).toBeVisible()
}

const ALPHA: Kind = { text: 'alpha', listStyle: 'bullet', todo: null }
const BETA: Kind = { text: 'beta', listStyle: 'bullet', todo: null }
const GAMMA: Kind = { text: 'gamma', listStyle: null, todo: 'TODO' }
const DELTA: Kind = { text: 'delta typed', listStyle: null, todo: null }

test.describe('one Ctrl+Z takes back a kind change with the kind it took off @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    // Edits less than `UNDO_GROUP_WINDOW_MS` apart join one undo entry: the
    // clock steps past it, so the edit made first stays an entry of its own.
    await page.clock.install()
    await waitForBoot(page)
  })

  /**
   * Seed a page and open it in block mode, with `delta` edited first: the undo
   * of the kind change must leave that edit. Resolves the blocks' ids and a way
   * back to the page.
   */
  async function inBlockMode(page: Page, title: string) {
    const ids = (await seed(page, title)) as [string, string, string, string]
    await openViaPalette(page, title)
    await focusBlockById(page, ids[3])
    await page.keyboard.press('End')
    await page.keyboard.type(' typed')
    await saveBlock(page, 'Escape')
    await expect.poll(async () => (await kindOf(page, ids[3])).text).toBe('delta typed')
    await page.clock.fastForward(1000)
    const reopen = async () => {
      await openViaPalette(page, 'Getting Started')
      await openViaPalette(page, title)
    }
    return { ids, reopen }
  }

  /** `inBlockMode`, in page mode; also resolves a slash command at the end of a block. */
  async function inPageMode(page: Page, title: string) {
    const ids = (await seed(page, title)) as [string, string, string, string]
    await openInPageMode(page, title)
    await caretAtEnd(page, 3)
    await page.keyboard.type(' typed')
    await caretAtEnd(page, 0)
    await expect.poll(async () => (await kindOf(page, ids[3])).text).toBe('delta typed')
    await page.clock.fastForward(1000)
    const menu = activeSuggestionPopup(page)
    const command = async (index: number, query: string, id: string) => {
      await caretAtEnd(page, index)
      await page.keyboard.type(` /${query}`)
      await menu.locator(`#suggestion-${id}`).click()
      await expect(menu).toHaveCount(0)
    }
    const reopen = async () => {
      await openViaPalette(page, 'Getting Started')
      await openInPageMode(page, title)
    }
    return { ids, command, reopen }
  }

  test('block mode: a bullet made a heading with /h2', async ({ page }) => {
    const {
      ids: [alpha, , , delta],
      reopen,
    } = await inBlockMode(page, 'Block heading undo')
    await focusBlockById(page, alpha)
    await page.keyboard.press('End')
    await runSlashCommand(page, 'h2', 'Heading 2 — Medium heading')
    await saveBlock(page, 'Escape')
    await expect
      .poll(() => kindOf(page, alpha))
      .toEqual({ text: '## alpha', listStyle: null, todo: null })

    await pageUndo(page)
    await reopen()

    await expect.poll(() => kindOf(page, alpha)).toEqual(ALPHA)
    expect(await kindOf(page, delta)).toEqual(DELTA)
  })

  test('block mode: a bullet made code from the toolbar', async ({ page }) => {
    const {
      ids: [alpha, , , delta],
      reopen,
    } = await inBlockMode(page, 'Block code undo')
    await focusBlockById(page, alpha)
    await page.keyboard.press('End')
    await page
      .locator('[data-testid="block-editor"]')
      .getByRole('button', { name: 'Turn into', exact: true })
      .click()
    await page.getByRole('menuitem', { name: 'Code block', exact: true }).click()
    // A language no built-in row has, so the picker offers it as its custom row.
    const language = page.getByRole('textbox', { name: 'Code block language' })
    await language.fill('zzlang')
    await page.getByTestId('use-custom-language').click()
    await expect(language).toHaveCount(0)
    await saveBlock(page, 'Escape')
    await expect
      .poll(() => kindOf(page, alpha))
      .toEqual({ text: '```zzlang\nalpha\n```', listStyle: null, todo: null })

    await pageUndo(page)
    await reopen()

    await expect.poll(() => kindOf(page, alpha)).toEqual(ALPHA)
    expect(await kindOf(page, delta)).toEqual(DELTA)
  })

  test('block mode: a bullet made a task', async ({ page }) => {
    const {
      ids: [, beta, , delta],
      reopen,
    } = await inBlockMode(page, 'Block task undo')
    await focusBlockById(page, beta)
    await page.keyboard.press('Control+Enter')
    await saveBlock(page, 'Escape')
    await expect
      .poll(() => kindOf(page, beta))
      .toEqual({ text: 'beta', listStyle: null, todo: 'TODO' })

    await pageUndo(page)
    await reopen()

    await expect.poll(() => kindOf(page, beta)).toEqual(BETA)
    expect(await kindOf(page, delta)).toEqual(DELTA)
  })

  test('block mode: a task made bulleted', async ({ page }) => {
    const {
      ids: [, , gamma, delta],
      reopen,
    } = await inBlockMode(page, 'Block bullet undo')
    await focusBlockById(page, gamma)
    await runSlashCommand(page, 'bullet', 'BULLET LIST — Insert unordered list')
    await saveBlock(page, 'Escape')
    await expect
      .poll(() => kindOf(page, gamma))
      .toEqual({ text: 'gamma', listStyle: 'bullet', todo: null })

    await pageUndo(page)
    await reopen()

    await expect.poll(() => kindOf(page, gamma)).toEqual(GAMMA)
    expect(await kindOf(page, delta)).toEqual(DELTA)
  })

  test('page mode: a bullet made a heading with /h2', async ({ page }) => {
    const {
      ids: [alpha, , , delta],
      command,
      reopen,
    } = await inPageMode(page, 'Page heading undo')
    await command(0, 'h2', 'h2')
    await expect
      .poll(() => kindOf(page, alpha))
      .toEqual({ text: '## alpha', listStyle: null, todo: null })

    await pageUndo(page)
    await reopen()

    await expect.poll(() => kindOf(page, alpha)).toEqual(ALPHA)
    expect(await kindOf(page, delta)).toEqual(DELTA)
  })

  test('page mode: a bullet made a task', async ({ page }) => {
    const {
      ids: [, beta, , delta],
      reopen,
    } = await inPageMode(page, 'Page task undo')
    await caretAtEnd(page, 1)
    await page.keyboard.press('Control+Enter')
    await expect
      .poll(() => kindOf(page, beta))
      .toEqual({ text: 'beta', listStyle: null, todo: 'TODO' })

    await pageUndo(page)
    await reopen()

    await expect.poll(() => kindOf(page, beta)).toEqual(BETA)
    expect(await kindOf(page, delta)).toEqual(DELTA)
  })

  test('page mode: a task made bulleted', async ({ page }) => {
    const {
      ids: [, , gamma, delta],
      command,
      reopen,
    } = await inPageMode(page, 'Page bullet undo')
    await command(2, 'bullet', 'bullet-list')
    await expect
      .poll(() => kindOf(page, gamma))
      .toEqual({ text: 'gamma', listStyle: 'bullet', todo: null })

    await pageUndo(page)
    await reopen()

    await expect.poll(() => kindOf(page, gamma)).toEqual(GAMMA)
    expect(await kindOf(page, delta)).toEqual(DELTA)
  })
})
