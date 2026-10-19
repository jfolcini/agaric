import type { Locator, Page } from '@playwright/test'

import {
  activePopover,
  expect,
  ipc,
  navigateToView,
  openPage,
  seedSearchBlocks,
  test,
  waitForBoot,
} from './helpers'

/**
 * Happy paths for two Tags & links features (#5736), both answered by mock
 * handlers the conformance fixtures pin to the backend, so a broken frontend
 * shows here:
 *
 *   - the Tags view's nested tag-query composer (`query_by_tag_expr`, pinned by
 *     `conformance/fixtures/query_tag_and_property_boundaries.json`);
 *   - the linked-references link-kind toggle (`list_backlinks_grouped`'s
 *     `kind`, pinned by `conformance/fixtures/block_ref_kind.json`);
 *   - a tag chip whose tag the resolve store never listed reading its name
 *     (`batch_resolve`, pinned by its `queries` step).
 */

/** `SEED_IDS` in `src/lib/tauri-mock/seed.ts`. */
const GETTING_STARTED = '00000000000000000000PAGE01'
const GS1 = '0000000000000000000BLOCK01'

async function createTag(page: Page, name: string): Promise<string> {
  const { id } = await ipc<{ id: string }>(page, 'create_block', {
    blockType: 'tag',
    content: name,
    parentId: null,
    index: null,
    scope: { kind: 'active', space_id: 'SPACE_PERSONAL' },
    blockId: null,
  })
  return id
}

test.describe('Tag query composer @editor @pages', () => {
  test('(alpha OR beta) AND NOT gamma lists exactly the blocks it admits', async ({ page }) => {
    await waitForBoot(page)
    const alpha = await createTag(page, 'alpha')
    const beta = await createTag(page, 'beta')
    const gamma = await createTag(page, 'gamma')
    // Each block is pinned by one operator: the "Only" pair only by the OR (an
    // AND admits neither), the "with gamma" pair only by the NOT, "No tags" by
    // neither branch of the OR.
    await seedSearchBlocks(page, [
      { content: 'Only alpha', tagIds: [alpha] },
      { content: 'Only beta', tagIds: [beta] },
      { content: 'Alpha with gamma', tagIds: [alpha, gamma] },
      { content: 'Beta with gamma', tagIds: [beta, gamma] },
      { content: 'No tags' },
    ])
    await navigateToView(page, 'Tags')

    const addTag = async (trigger: Locator, name: string) => {
      await trigger.click()
      const popover = activePopover(page)
      await popover.getByRole('textbox', { name: 'Search tags to add' }).fill(name)
      await popover.getByRole('button', { name: new RegExp(`^${name}`) }).click()
      await expect(page.getByRole('button', { name: `Negate ${name} (NOT)` })).toBeVisible()
    }

    await page.getByRole('button', { name: 'Advanced', exact: true }).click()
    const root = page.getByRole('group', { name: 'Tag query group', exact: true })
    await root.getByRole('button', { name: 'Group', exact: true }).click()
    const nested = page.getByRole('group', { name: 'Nested tag query group', exact: true })
    await nested.getByRole('radio', { name: 'Any', exact: true }).click()
    await addTag(nested.getByRole('button', { name: 'Tag', exact: true }), 'alpha')
    await addTag(nested.getByRole('button', { name: 'Tag', exact: true }), 'beta')
    // The root's own add row renders after its children, so its Tag button is
    // the last one inside it.
    await addTag(root.getByRole('button', { name: 'Tag', exact: true }).last(), 'gamma')
    const notGamma = page.getByRole('button', { name: 'Negate gamma (NOT)', exact: true })
    await notGamma.click()
    await expect(notGamma).toHaveAttribute('aria-pressed', 'true')
    // Rows come back in block-id order, which is the seed order.
    await expect(page.locator('[data-result-item]')).toHaveText([/^Only alpha/, /^Only beta/])
  })
})

test.describe('Linked references link kind @editor @pages', () => {
  test('All, Page links and Block refs narrow the list and the header count', async ({ page }) => {
    await waitForBoot(page)
    // Quick Notes' seeded QN_1 already page-links Getting Started; this adds
    // the block ref.
    await seedSearchBlocks(page, [{ content: `Block ref note ((${GETTING_STARTED}))` }])
    await openPage(page, 'Getting Started')

    const references = page.getByTestId('linked-references')
    const header = references.getByRole('button', { name: /^Collapse \d+ References?$/ })
    const rows = references.locator('[data-backlink-item]')
    const kind = (name: string) =>
      references
        .getByRole('radiogroup', { name: 'Filter by link kind', exact: true })
        .getByRole('radio', { name, exact: true })

    // Groups order by source-page title: Projects, then Quick Notes.
    await expect(header).toHaveText('2 References')
    await expect(rows).toHaveText([/^Block ref note/, /^These notes complement/])

    await kind('Page links').click()
    await expect(header).toHaveText('1 Reference')
    await expect(rows).toHaveText([/^These notes complement/])

    await kind('Block refs').click()
    await expect(header).toHaveText('1 Reference')
    await expect(rows).toHaveText([/^Block ref note/])

    await kind('All').click()
    await expect(header).toHaveText('2 References')
    await expect(rows).toHaveText([/^Block ref note/, /^These notes complement/])
  })
})

test.describe('Tag chip name @editor @pages', () => {
  // The tag is made after boot, so the resolve store's preload never listed it, as the backend's
  // background-filled `tags_cache` misses a tag an import just created.
  test('a tag the resolve store never listed shows its name, not its id', async ({ page }) => {
    await waitForBoot(page)
    const tagId = await createTag(page, 'fresh-tag')
    await ipc(page, 'edit_block', { blockId: GS1, toText: `see #[${tagId}]` })
    await openPage(page, 'Getting Started')

    await expect(page.locator(`[data-block-id="${GS1}"] [data-testid="tag-ref-chip"]`)).toHaveText(
      'fresh-tag',
    )
  })
})
