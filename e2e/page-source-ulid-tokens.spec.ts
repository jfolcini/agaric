import type { Locator, Page } from '@playwright/test'

import { expect, test, waitForBoot } from './helpers'

/**
 * #5686 — the ULIDs a page's text keeps for block refs, ref properties and
 * links: the outline shows titles in their place, and Edit as Markdown keeps
 * them as ids, hinting each one's title and keeping it whole.
 */

const HOST = 'Ulid token host'
const TARGET = 'Ulid token target'
const REF_TITLE = 'Call the bank'

interface Seeded {
  targetId: string
  refId: string
}

/** A host page holding a heading linking the target page, and a block referring to a block on it, its ref property naming the page. */
async function seed(page: Page): Promise<Seeded> {
  return page.evaluate(
    async ({ host, target, refTitle }) => {
      const { invoke } = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__
      const spaceId = 'SPACE_PERSONAL'
      const targetId = (await invoke('create_page_in_space', {
        parentId: null,
        content: target,
        spaceId,
      })) as string
      const created = (await invoke('create_blocks_batch', {
        specs: [{ blockType: 'content', content: refTitle, parentId: targetId, position: null }],
      })) as { blocks: Array<{ id: string }> }
      const hostId = (await invoke('create_page_in_space', {
        parentId: null,
        content: host,
        spaceId,
      })) as string
      const refId = (created.blocks[0] as { id: string }).id
      const hosted = (await invoke('create_blocks_batch', {
        specs: [`# Plan for [[${targetId}]]`, `See ((${refId})) today`].map((content) => ({
          blockType: 'content',
          content,
          parentId: hostId,
          position: null,
        })),
      })) as { blocks: Array<{ id: string }> }
      await invoke('set_property', {
        blockId: (hosted.blocks[1] as { id: string }).id,
        key: 'owner',
        value: { value_ref: targetId },
      })
      return { targetId, refId }
    },
    { host: HOST, target: TARGET, refTitle: REF_TITLE },
  )
}

async function openHost(page: Page): Promise<void> {
  await page.keyboard.press('Control+k')
  await page.locator('[cmdk-input]').first().fill(HOST)
  await page.locator('[cmdk-item]').filter({ hasText: HOST }).first().click()
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(HOST)
  await page.locator('[data-testid="block-static"]').filter({ hasText: 'See' }).waitFor()
}

async function openSourceMode(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Page actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Edit as Markdown', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
  await expect(editor).toContainText('See ((')
  // ProseMirror writes its own selection back over the DOM's shortly after a focus.
  await expect(editor).toBeFocused()
  return editor
}

/** The generated hint under `token`, or `none` while it shows none. */
function hintOf(token: Locator): Promise<string> {
  return token.evaluate((el) => getComputedStyle(el, '::after').content)
}

/** Put the caret `offset` characters past the start of the buffer text `find`. */
async function caretAt(page: Page, find: string, offset: number): Promise<void> {
  await page.evaluate(
    ({ needle, by }) => {
      const dom = document.querySelector('[data-testid="page-source-editor"]') as HTMLElement & {
        editor: {
          state: {
            doc: { forEach: (f: (line: { textContent: string }, at: number) => void) => void }
          }
          commands: { setTextSelection: (pos: number) => boolean }
        }
      }
      let pos: number | null = null
      dom.editor.state.doc.forEach((line, at) => {
        const i = line.textContent.indexOf(needle)
        if (pos === null && i >= 0) pos = at + 1 + i + by
      })
      if (pos === null) throw new Error(`caretAt: no line holds ${needle}`)
      dom.editor.commands.setTextSelection(pos)
    },
    { needle: find, by: offset },
  )
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await waitForBoot(page)
})

test('the outline shows a heading’s link by its page’s title, not its id @editor @pages @markdown', async ({
  page,
}) => {
  const { targetId } = await seed(page)
  await openHost(page)

  await page.getByRole('button', { name: 'Page actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Open outline', exact: true }).click()

  const heading = page
    .getByRole('navigation', { name: 'Page outline' })
    .getByRole('button', { name: `Plan for ${TARGET}`, exact: true })
  await expect(heading).toBeVisible()
  await expect(heading).not.toContainText(targetId)
})

test('a block ref in Edit as Markdown hints its title, goes whole, comes back whole, and takes no typing @editor @pages @markdown', async ({
  page,
}) => {
  const { refId, targetId } = await seed(page)
  await openHost(page)
  const editor = await openSourceMode(page)
  const line = editor.locator('[data-source-line]', { hasText: /^See / })
  const ref = editor.locator('.source-ulid-token', { hasText: refId })
  const owner = editor.locator('.source-ulid-token', { hasText: new RegExp(`^${targetId}$`) })

  // Hover: the hint is drawn under the token, and the text is unchanged.
  await expect(ref).toHaveAttribute('data-ulid-hint', REF_TITLE)
  expect(await hintOf(ref)).toBe('none')
  await ref.hover()
  await expect.poll(() => hintOf(ref)).toContain(REF_TITLE)
  await owner.hover()
  await expect.poll(() => hintOf(owner)).toContain(TARGET)
  await expect(line).toHaveText(`See ((${refId})) today`)

  // The cursor touching the token: the hint shows, and assistive tech hears the title.
  await page.mouse.move(0, 0)
  await caretAt(page, `((${refId}))`, refId.length + 4)
  await expect(ref).toHaveAttribute('data-ulid-active', '')
  await expect.poll(() => hintOf(ref)).toContain(REF_TITLE)
  await expect(page.getByRole('status').filter({ hasText: REF_TITLE })).toHaveText(
    `Points to ${REF_TITLE}`,
  )

  // Backspace beside it removes it whole; one undo brings it back.
  await page.keyboard.press('Backspace')
  await expect(line).toHaveText('See  today')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(line).toHaveText(`See ((${refId})) today`)

  // Typing inside it is refused.
  await caretAt(page, `((${refId}))`, 6)
  await page.keyboard.type('x')
  await expect(line).toHaveText(`See ((${refId})) today`)
})
