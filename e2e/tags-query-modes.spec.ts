import type { Page } from '@playwright/test'

import { expect, navigateToView, test, waitForBoot } from './helpers'

/**
 * The Tags view's filter panel returns the blocks its mode selects (#5366):
 * with two selected tags AND lists their intersection and OR their union, and
 * "Include inherited tags" adds the children of a tagged page. Assertions read
 * the rendered result rows, which come back in block-id order (`query_by_tags`,
 * pinned by conformance/fixtures/query_tag_and_property_boundaries.json).
 *
 * Seeded through the mock IPC, in this order so the ids ascend with it:
 *
 *   Tag Modes (page, untagged)
 *     Alpha only        alpha
 *     Beta only         beta
 *     Alpha and beta    alpha, beta
 *   Beta Page (page)    beta
 *     Inherited one
 *     Inherited two
 */

const PERSONAL = 'SPACE_PERSONAL'

function ipc<T>(page: Page, cmd: string, args: unknown): Promise<T> {
  return page.evaluate(
    ({ c, a }) => {
      const invoke = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__.invoke
      return invoke(c, a)
    },
    { c: cmd, a: args },
  ) as Promise<T>
}

function createPage(page: Page, title: string): Promise<string> {
  return ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: PERSONAL,
  })
}

async function createBlock(
  page: Page,
  blockType: 'content' | 'tag',
  content: string,
  parentId: string | null,
): Promise<string> {
  const row = await ipc<{ id: string }>(page, 'create_block', {
    blockType,
    content,
    parentId,
    index: null,
    scope: { kind: 'active', space_id: PERSONAL },
    blockId: null,
  })
  return row.id
}

async function seedTaggedBlocks(page: Page): Promise<void> {
  const modes = await createPage(page, 'Tag Modes')
  const alphaOnly = await createBlock(page, 'content', 'Alpha only', modes)
  const betaOnly = await createBlock(page, 'content', 'Beta only', modes)
  const both = await createBlock(page, 'content', 'Alpha and beta', modes)
  const betaPage = await createPage(page, 'Beta Page')
  await createBlock(page, 'content', 'Inherited one', betaPage)
  await createBlock(page, 'content', 'Inherited two', betaPage)

  const alpha = await createBlock(page, 'tag', 'alpha', null)
  const beta = await createBlock(page, 'tag', 'beta', null)
  const tag = (blockId: string, tagId: string) => ipc(page, 'add_tag', { blockId, tagId })
  await tag(alphaOnly, alpha)
  await tag(betaOnly, beta)
  await tag(both, alpha)
  await tag(both, beta)
  await tag(betaPage, beta)
}

async function selectTag(page: Page, name: string): Promise<void> {
  await page.getByLabel('Search tags by prefix').fill(name)
  await page
    .getByRole('grid', { name: 'Matching tags', exact: true })
    .getByRole('row')
    .filter({ hasText: name })
    .getByRole('button', { name: 'Add', exact: true })
    .click()
  await expect(page.getByRole('button', { name: `Remove tag ${name}`, exact: true })).toBeVisible()
}

/** Each result row starts with its block's content. */
function results(page: Page) {
  return page.locator('[data-result-item]')
}

test.describe('Tag filter modes return the matching blocks (#5366)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await seedTaggedBlocks(page)
    await navigateToView(page, 'Tags')
  })

  test('AND lists the intersection of two tags, OR their union', async ({ page }) => {
    await selectTag(page, 'alpha')
    await selectTag(page, 'beta')

    await page.getByRole('button', { name: 'AND', exact: true }).click()
    await expect(results(page)).toHaveText([/^Alpha and beta/])

    await page.getByRole('button', { name: 'OR', exact: true }).click()
    await expect(results(page)).toHaveText([
      /^Alpha only/,
      /^Beta only/,
      /^Alpha and beta/,
      /^Beta Page/,
    ])
  })

  test("Include inherited tags adds a tagged page's children", async ({ page }) => {
    await selectTag(page, 'beta')
    await expect(results(page)).toHaveText([/^Beta only/, /^Alpha and beta/, /^Beta Page/])

    const inherited = page.getByRole('switch', { name: 'Include inherited tags', exact: true })
    await inherited.click()
    await expect(inherited).toHaveAttribute('aria-checked', 'true')
    await expect(results(page)).toHaveText([
      /^Beta only/,
      /^Alpha and beta/,
      /^Beta Page/,
      /^Inherited one/,
      /^Inherited two/,
    ])

    await inherited.click()
    await expect(results(page)).toHaveText([/^Beta only/, /^Alpha and beta/, /^Beta Page/])
  })
})
