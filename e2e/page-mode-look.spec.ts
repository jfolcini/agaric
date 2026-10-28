/**
 * Page mode's document look (#5691) against the mock backend: a page reads as a
 * document in a frame, with the footer's hint under it, and a block's property
 * chips and attachment badge hidden at rest, shown on the pointer, the caret or
 * the focus, and reachable by Tab, while its dates and priority stay shown,
 * with no axe violations.
 */

import { createRequire } from 'node:module'

import type { Locator, Page } from '@playwright/test'

import { expect, ipc, test, waitForBoot } from './helpers'

const axePath = createRequire(import.meta.url).resolve('axe-core')
const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const EDITOR = '[data-testid="page-mode-editor"]'
const HINT = 'Supports Markdown. Type / for commands'

type Row = [depth: number, text: string]

async function seedRows(page: Page, title: string, rows: readonly Row[]) {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SCOPE.space_id,
  })
  const ids: string[] = []
  const atDepth: string[] = [pageId]
  for (const [depth, content] of rows) {
    const row = await ipc<{ id: string }>(page, 'create_block', {
      blockType: 'content',
      content,
      parentId: atDepth[depth],
      index: null,
      scope: SCOPE,
    })
    atDepth[depth + 1] = row.id
    ids.push(row.id)
  }
  return { pageId, ids }
}

const text = (value: string) => ({
  value_text: value,
  value_num: null,
  value_date: null,
  value_ref: null,
  value_bool: null,
})

async function openInPageMode(page: Page, title: string, count: number): Promise<void> {
  await page.keyboard.press('Control+k')
  const input = page.locator('[cmdk-input]').first()
  await input.fill(title)
  await page.locator('[cmdk-item]').filter({ hasText: title }).first().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
  await page
    .getByRole('radiogroup', { name: 'Editing mode' })
    .getByRole('radio', { name: 'Page' })
    .click()
  await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(count)
}

/** A document: headings, a paragraph, a task with a priority, a due date and a property, and lists. */
async function seedDocument(page: Page) {
  const seeded = await seedRows(page, 'Document look', [
    [0, '# Release notes'],
    [0, 'The editor now reads as a document, with headings, lists and tasks in one flow.'],
    [0, '## Tasks'],
    [0, 'Ship the editor'],
    [0, 'Write the changelog'],
    [0, '## Highlights'],
    [0, 'Toolbar'],
    [1, 'Sticky above the page'],
    [0, 'Bubble menus'],
    [0, 'Read the issue'],
    [0, 'Try it out'],
  ])
  const { ids } = seeded
  await ipc(page, 'set_todo_state', { blockId: ids[3], state: 'TODO' })
  await ipc(page, 'set_priority', { blockId: ids[3], level: '1' })
  await ipc(page, 'set_due_date', { blockId: ids[3], date: '2099-01-15' })
  await ipc(page, 'set_property', { blockId: ids[3], key: 'assignee', value: text('Ana') })
  for (const id of [ids[6], ids[7], ids[8]]) {
    await ipc(page, 'set_property', { blockId: id, key: 'listStyle', value: text('bullet') })
  }
  for (const id of [ids[9], ids[10]]) {
    await ipc(page, 'set_property', { blockId: id, key: 'listStyle', value: text('ordered') })
  }
  await openInPageMode(page, 'Document look', 11)
  return seeded
}

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: axePath })
  return page.evaluate(async () => {
    const { axe } = window as unknown as {
      axe: { run: (el: Element) => Promise<{ violations: Array<{ id: string }> }> }
    }
    const { violations } = await axe.run(document.querySelector('.page-editor') as Element)
    return violations.map((v) => v.id)
  })
}

const opacity = (locator: Locator) => locator.evaluate((el) => getComputedStyle(el).opacity)

test.describe('page mode document look (#5691) @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    // axe reads colours, which a fade in progress makes wrong.
    await page.emulateMedia({ reducedMotion: 'reduce' })
  })

  test('the page reads as a document in a frame, the footer hints at Markdown and /, and it passes axe', async ({
    page,
  }) => {
    const { ids } = await seedDocument(page)
    await page.mouse.move(0, 0)
    const task = page.locator(`${EDITOR} [data-page-block-id="${ids[3]}"]`)
    await expect(task.locator('.due-date-chip')).toBeVisible()

    await expect(page.getByText(HINT)).toBeVisible()
    // The task's dates and priority stay shown at rest; its property chip does not.
    expect(await opacity(task.locator('.due-date-chip'))).toBe('1')
    expect(await opacity(task.locator('[data-testid="priority-badge"]'))).toBe('1')
    expect(await opacity(task.locator('[data-testid="property-chip"]'))).toBe('0')
    // Paragraphs spaced as a document's, list items closer.
    const gap = (id: string | undefined) =>
      page
        .locator(`${EDITOR} [data-page-block-id="${id}"]`)
        .evaluate((el) => getComputedStyle(el).marginTop)
    expect(await gap(ids[4])).toBe('12px')
    expect(await gap(ids[7])).toBe('4px')
    expect(await axeViolations(page)).toEqual([])
  })

  test('a property chip shows on the pointer, the caret and the focus, Shift+Tab reaches it, and it passes axe', async ({
    page,
  }) => {
    const { ids } = await seedRows(page, 'Chips at rest', [
      [0, 'plain'],
      [0, 'with a chip'],
    ])
    await ipc(page, 'set_property', { blockId: ids[1], key: 'assignee', value: text('Ana') })
    await openInPageMode(page, 'Chips at rest', 2)
    const owner = page.locator(`${EDITOR} [data-page-block-id="${ids[1]}"]`)
    const chip = owner.locator('[data-testid="property-chip"]')
    await expect(chip).toHaveAttribute('aria-label', 'Assignee: Ana')
    const box = await chip.boundingBox()
    await page.mouse.move(0, 0)
    await expect.poll(() => opacity(chip)).toBe('0')

    // The pointer on its block shows it, in the place it had.
    await owner.locator('.page-block-content').hover()
    await expect.poll(() => opacity(chip)).toBe('1')
    expect(await chip.boundingBox()).toEqual(box)
    await page.mouse.move(0, 0)
    await expect.poll(() => opacity(chip)).toBe('0')

    // The caret in its block shows it; in another block, not.
    await owner.locator('.page-block-content').click()
    await expect(owner).toHaveClass(/page-block-current/)
    // No ring or tint marks it.
    expect(
      await owner.evaluate((el) => [
        getComputedStyle(el).boxShadow,
        getComputedStyle(el).backgroundColor,
      ]),
    ).toEqual(['none', 'rgba(0, 0, 0, 0)'])
    await page.mouse.move(0, 0)
    await expect.poll(() => opacity(chip)).toBe('1')
    await page.locator(`${EDITOR} [data-page-block-id="${ids[0]}"] .page-block-content`).click()
    await page.mouse.move(0, 0)
    await expect.poll(() => opacity(chip)).toBe('0')

    // Shift+Tab from what follows the footer lands on it, the last control in the text, and shows it.
    await page.getByText(HINT).evaluate((footer) => {
      const after = [...document.querySelectorAll<HTMLElement>('button, a[href], [tabindex="0"]')]
      after
        .find((el) => (footer.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)
        ?.focus()
    })
    await page.keyboard.press('Shift+Tab')
    await expect(chip.getByRole('button', { name: 'Assignee: Ana' })).toBeFocused()
    await expect.poll(() => opacity(chip)).toBe('1')
    expect(await axeViolations(page)).toEqual([])
  })
})
