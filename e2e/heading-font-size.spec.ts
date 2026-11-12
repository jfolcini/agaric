/**
 * Headings follow the font-size setting (#6558): they are sized in multiples
 * of `--agaric-font-size`, so at Large on a phone a heading still outranks body
 * text, and at Medium on a desktop the sizes stay 24 / 20 / 18 / 16 / 14 / 12.
 * The static render, the roving editor and page mode share the sizes.
 */

import type { Locator, Page } from '@playwright/test'

import { expect, focusBlockById, ipc, test, waitForBoot } from './helpers'

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const LEVELS = [1, 2, 3, 4, 5, 6] as const

async function seed(page: Page, title: string): Promise<Record<number, string>> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SCOPE.space_id,
  })
  const ids: Record<number, string> = {}
  for (const level of [0, ...LEVELS]) {
    const content = level === 0 ? 'Body text' : `${'#'.repeat(level)} Heading ${level}`
    const { id } = await ipc<{ id: string }>(page, 'create_block', {
      blockType: 'content',
      content,
      parentId: pageId,
      index: null,
      scope: SCOPE,
    })
    ids[level] = id
  }
  return ids
}

async function open(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Control+k')
  await page.locator('[cmdk-input]').first().fill(title)
  await page.locator('[cmdk-item]').filter({ hasText: title }).first().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
}

function px(element: Locator): Promise<number> {
  return element.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))
}

/** Body text's size followed by h1…h6's, in px. */
async function sizes(scope: Locator): Promise<number[]> {
  const body = await px(scope.locator('p').filter({ hasText: 'Body text' }).first())
  const headings: number[] = []
  for (const level of LEVELS) {
    headings.push(await px(scope.locator(`h${level}`).first()))
  }
  return [body, ...headings]
}

async function staticSizes(page: Page, ids: Record<number, string>): Promise<number[]> {
  const out: number[] = []
  for (const level of [0, ...LEVELS]) {
    const block = page.locator(`[data-testid="block-static"][data-block-id="${ids[level]}"]`)
    out.push(await px(level === 0 ? block : block.locator(`h${level}`).first()))
  }
  return out
}

async function toPageMode(page: Page): Promise<Locator> {
  await page
    .getByRole('radiogroup', { name: 'Editing mode' })
    .getByRole('radio', { name: 'Page' })
    .click()
  const editor = page.locator('[data-testid="page-mode-editor"]')
  await expect(editor.locator('[data-page-block]')).toHaveCount(7)
  return editor
}

function expectDescending([body, h1, h2, h3]: number[]): void {
  expect(h1, 'h1 > h2').toBeGreaterThan(h2 as number)
  expect(h2, 'h2 > h3').toBeGreaterThan(h3 as number)
  expect(h3, 'h3 > body').toBeGreaterThan(body as number)
}

test.describe('headings scale with the font-size setting @editor @pages', () => {
  test.describe('at 390 px, Large', () => {
    test.use({ viewport: { width: 390, height: 844 } })
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem('agaric-font-size', 'large'))
      await waitForBoot(page)
    })

    test('h1 > h2 > h3 > body in block mode, the editor and page mode', async ({ page }) => {
      const ids = await seed(page, 'Headings large')
      await open(page, 'Headings large')
      const rendered = await staticSizes(page, ids)
      expect(rendered[0]).toBe(18)
      expectDescending(rendered)

      await focusBlockById(page, ids[2] as string)
      const editing = await px(page.locator('[data-testid="block-editor"] .ProseMirror h2'))
      expect(editing).toBe(rendered[2])

      expectDescending(await sizes(await toPageMode(page)))
    })
  })

  test.describe('at 1280 px, Medium', () => {
    test.use({ viewport: { width: 1280, height: 800 } })
    test.beforeEach(async ({ page }) => {
      await waitForBoot(page)
    })

    test('the sizes are 24 / 20 / 18 / 16 / 14 / 12 in every mode', async ({ page }) => {
      const ids = await seed(page, 'Headings medium')
      await open(page, 'Headings medium')
      const expected = [16, 24, 20, 18, 16, 14, 12]
      expect(await staticSizes(page, ids)).toEqual(expected)

      await focusBlockById(page, ids[1] as string)
      expect(await px(page.locator('[data-testid="block-editor"] .ProseMirror h1'))).toBe(24)

      expect(await sizes(await toPageMode(page))).toEqual(expected)
    })
  })
})
