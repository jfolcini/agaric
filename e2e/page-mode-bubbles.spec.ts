/**
 * The editor's bubble menus (#5691) against the mock backend: page mode's link,
 * table and code-block bubbles, and the image bubble that block mode and page mode
 * share. Each change is read back from the backend, then again after leaving the
 * page and coming back.
 */

import type { Locator, Page } from '@playwright/test'

import {
  activePopover,
  expect,
  focusBlockById,
  getInvokeCalls,
  installIpcRecorder,
  ipc,
  readClipboard,
  test,
  waitForBoot,
} from './helpers'

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const EDITOR = '[data-testid="page-mode-editor"]'
/** Same-origin, so it loads without the external-image gate. */
const IMG = '/agaric.svg'

interface Seeded {
  pageId: string
  ids: string[]
}

async function seedPage(page: Page, title: string, contents: readonly string[]): Promise<Seeded> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SCOPE.space_id,
  })
  const ids: string[] = []
  for (const content of contents) {
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
  // Escape leaves page mode's editor for the box around it; a Ctrl+K in the editor is its link's.
  await expect
    .poll(() => page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, EDITOR))
    .toBe(false)
  await page.keyboard.press('Control+k')
  const input = page.locator('[cmdk-input]').first()
  await input.fill(title)
  await page.locator('[cmdk-item]').filter({ hasText: title }).first().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
}

function modeSwitch(page: Page, name: 'Blocks' | 'Page'): Locator {
  return page.getByRole('radiogroup', { name: 'Editing mode' }).getByRole('radio', { name })
}

async function openInPageMode(page: Page, title: string, count: number): Promise<void> {
  await openViaPalette(page, title)
  await modeSwitch(page, 'Page').click()
  await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(count)
}

/** Leave the page and come back to it, which re-reads it from the backend. */
async function reopen(page: Page, title: string): Promise<void> {
  await openViaPalette(page, 'Getting Started')
  await openViaPalette(page, title)
}

const block = (page: Page, id: string | undefined): Locator =>
  page.locator(`${EDITOR} [data-page-block-id="${id}"] .page-block-content`)

const stored = async (page: Page, id: string | undefined): Promise<string> =>
  (await ipc<{ content: string | null }>(page, 'get_block', { blockId: id })).content ?? ''

const bubble = (page: Page, testId: string): Locator => page.getByTestId(testId)

test.describe('page mode bubble menus @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('caret in a link shows its bubble; Open opens the href and Remove unlinks it', async ({
    page,
  }) => {
    const { ids } = await seedPage(page, 'Bubble link', ['see [example](https://example.com) here'])
    await openInPageMode(page, 'Bubble link', 1)

    await block(page, ids[0]).locator('a').click()
    const link = bubble(page, 'page-link-bubble')
    await expect(link).toBeVisible()
    await expect(link).toContainText('https://example.com')
    // A caret in a link is not a selection: the marks bubble stays away.
    await expect(page.getByTestId('selection-bubble-menu')).toBeHidden()

    await installIpcRecorder(page)
    await link.getByRole('button', { name: 'Open link' }).click()
    await expect
      .poll(async () => (await getInvokeCalls(page, 'plugin:shell|open')).map((c) => c['path']))
      .toEqual(['https://example.com'])

    await link.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(block(page, ids[0]).locator('a')).toHaveCount(0)
    await expect(link).toBeHidden()
    await expect.poll(() => stored(page, ids[0])).toBe('see example here')

    await reopen(page, 'Bubble link')
    await expect(block(page, ids[0])).toHaveText('see example here')
    await expect(block(page, ids[0]).locator('a')).toHaveCount(0)
  })

  test('the table bubble adds a row that is still there after leaving the page', async ({
    page,
  }) => {
    const table = '| a | b |\n| --- | --- |\n| 1 | 2 |'
    const { ids } = await seedPage(page, 'Bubble table', [table])
    await openInPageMode(page, 'Bubble table', 1)
    const rows = block(page, ids[0]).locator('tr')
    await expect(rows).toHaveCount(2)

    await block(page, ids[0]).locator('td').first().click()
    const bar = bubble(page, 'page-table-bubble')
    await bar.getByRole('button', { name: 'Table' }).click()
    await page.getByTestId('table-op-insert-row-below').click()
    await expect(rows).toHaveCount(3)
    await expect.poll(async () => (await stored(page, ids[0])).split('\n').length).toBe(4)

    await reopen(page, 'Bubble table')
    await expect(rows).toHaveCount(3)
  })

  test('the code bubble sets the language in the stored fence, and Copy copies the code', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const { ids } = await seedPage(page, 'Bubble code', ['```\nconst x = 1\n```'])
    await openInPageMode(page, 'Bubble code', 1)

    await block(page, ids[0]).locator('pre').click()
    const bar = bubble(page, 'page-code-bubble')
    await bar.getByRole('button', { name: 'Copy code' }).click()
    await expect.poll(() => readClipboard(page)).toBe('const x = 1')

    await bar.getByRole('button', { name: 'Code block language' }).click()
    await page.getByRole('textbox', { name: 'Code block language' }).fill('python')
    await page.keyboard.press('Enter')
    await expect(bar.getByRole('button', { name: 'Code block language' })).toHaveText('python')
    await expect.poll(() => stored(page, ids[0])).toBe('```python\nconst x = 1\n```')

    await reopen(page, 'Bubble code')
    await expect.poll(() => stored(page, ids[0])).toBe('```python\nconst x = 1\n```')
    await block(page, ids[0]).locator('pre').click()
    await expect(bar.getByRole('button', { name: 'Code block language' })).toHaveText('python')
  })
})

test.describe('the image bubble @editor @pages @attachments', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('in page mode, the alt text changes with its width kept, and Remove deletes the image', async ({
    page,
  }) => {
    const { ids } = await seedPage(page, 'Bubble image', [
      `pic ![a cat|120](${IMG}) done`,
      `two ![a dog](${IMG}) end`,
    ])
    await openInPageMode(page, 'Bubble image', 2)

    await block(page, ids[0]).locator('img[alt="a cat"]').click()
    const bar = bubble(page, 'image-bubble-menu')
    await bar.getByRole('button', { name: 'Edit alt text' }).click()
    await activePopover(page).getByRole('textbox', { name: 'Alt text' }).fill('a lion')
    await page.keyboard.press('Enter')
    await expect(block(page, ids[0]).locator('img[alt="a lion"]')).toBeVisible()
    await expect.poll(() => stored(page, ids[0])).toBe(`pic ![a lion|120](${IMG}) done`)

    await block(page, ids[1]).locator('img[alt="a dog"]').click()
    await bar.getByRole('button', { name: 'Open image a dog in full screen' }).click()
    await expect(page.getByRole('dialog').locator('img[alt="a dog"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(bar.getByRole('button', { name: 'Remove image' })).toBeVisible()
    await bar.getByRole('button', { name: 'Remove image' }).click()
    await expect(block(page, ids[1]).locator('img')).toHaveCount(0)
    await expect.poll(() => stored(page, ids[1])).toBe('two  end')

    await reopen(page, 'Bubble image')
    await expect(block(page, ids[0]).locator('img[alt="a lion"]')).toBeVisible()
    await expect(block(page, ids[1]).locator('img')).toHaveCount(0)
  })

  test('in block mode, the alt text changes and Remove deletes the image', async ({ page }) => {
    const { ids } = await seedPage(page, 'Bubble image blocks', [
      `pic ![a cat](${IMG}) done`,
      `two ![a dog](${IMG}) end`,
    ])
    await openViaPalette(page, 'Bubble image blocks')
    const bar = bubble(page, 'image-bubble-menu')

    const first = await focusBlockById(page, ids[0] as string)
    await first.locator('img[alt="a cat"]').click()
    await bar.getByRole('button', { name: 'Edit alt text' }).click()
    await activePopover(page).getByRole('textbox', { name: 'Alt text' }).fill('a lion')
    await page.keyboard.press('Enter')
    await expect(first.locator('img[alt="a lion"]')).toBeVisible()

    const second = await focusBlockById(page, ids[1] as string)
    await second.locator('img[alt="a dog"]').click()
    await bar.getByRole('button', { name: 'Open image a dog in full screen' }).click()
    await expect(page.getByRole('dialog').locator('img[alt="a dog"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(bar.getByRole('button', { name: 'Remove image' })).toBeVisible()
    await bar.getByRole('button', { name: 'Remove image' }).click()
    await expect(second.locator('img')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect.poll(() => stored(page, ids[0])).toBe(`pic ![a lion](${IMG}) done`)
    await expect.poll(() => stored(page, ids[1])).toBe('two  end')

    await reopen(page, 'Bubble image blocks')
    const statics = page.locator('[data-testid="block-static"]')
    await expect(statics.locator('img[alt="a lion"]')).toBeVisible()
    await expect(statics.locator('img[alt="a dog"]')).toHaveCount(0)
  })
})
