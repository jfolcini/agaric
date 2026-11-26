/**
 * E2E — the page editor's four inconsistencies (#7040 P4), in blocks and in
 * page mode. The Properties header reads like every other section header: its
 * label, then its count in the muted count tone.
 */

import type { Locator, Page } from '@playwright/test'

import { SEED_IDS } from '@/lib/tauri-mock/seed'

import { expect, ipc, settleBackend, test, waitForBoot } from './helpers'

const TITLE = 'Polish showcase'
const SCOPE = { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL }
const DESKTOP = { viewport: { width: 1440, height: 900 } }

/** A page with a property, a note callout, a quote, a table and code, linked from Quick Notes. */
async function seed(page: Page): Promise<void> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: TITLE,
    spaceId: SEED_IDS.SPACE_PERSONAL,
  })
  await ipc(page, 'set_property', {
    blockId: pageId,
    key: 'status',
    value: { value_text: 'active' },
  })
  const block = (parentId: string, content: string) =>
    ipc(page, 'create_block', {
      blockType: 'content',
      content,
      parentId,
      index: null,
      scope: SCOPE,
      blockId: null,
    })
  for (const content of [
    '> [!NOTE] Decision\n> Sheets on phones.',
    '> A plain quote.',
    '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |',
    '```ts\nconst x = 1\n```',
  ]) {
    await block(pageId, content)
  }
  await block(SEED_IDS.PAGE_QUICK_NOTES, `See [[${pageId}]]`)
  await settleBackend(page)
}

async function openShowcase(page: Page): Promise<void> {
  await waitForBoot(page)
  await seed(page)
  await page.keyboard.press('Control+k')
  await page.locator('[cmdk-input]').first().fill(TITLE)
  await page.locator('[cmdk-item]').filter({ hasText: TITLE }).first().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(TITLE)
}

async function toPageMode(page: Page): Promise<void> {
  await page
    .getByRole('radiogroup', { name: 'Editing mode' })
    .getByRole('radio', { name: 'Page' })
    .click()
  await expect(page.getByTestId('page-mode-editor')).toBeVisible()
}

const css = (el: Locator, prop: string, pseudo?: string): Promise<string> =>
  el.evaluate((node, [p, ps]) => getComputedStyle(node, ps ?? null).getPropertyValue(p ?? ''), [
    prop,
    pseudo,
  ] as const)

/** The header names its count, which takes the count tone: muted and not bold. */
async function expectPropertiesHeader(page: Page): Promise<void> {
  const header = page.getByRole('button', { name: 'Properties 1', exact: true })
  await expect(header).toBeVisible()
  const count = header.locator('[data-slot="badge"][data-variant="metadata"]')
  await expect(count).toHaveText('1')
  expect(await css(count, 'font-weight'), 'count weight').toBe('400')
  expect(await css(count, 'color'), 'count colour').toBe(await css(header, 'color'))
}

test.describe('the Properties header @pages', () => {
  test.use(DESKTOP)

  test('reads its label, then its count in the count tone, in blocks and in page mode', async ({
    page,
  }) => {
    await openShowcase(page)
    await expectPropertiesHeader(page)
    await toPageMode(page)
    await expectPropertiesHeader(page)
  })
})
