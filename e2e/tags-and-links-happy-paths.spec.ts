import type { Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import { expect, ipc, openPage, seedSearchBlocks, test, waitForBoot } from './helpers'

/**
 * Happy paths for Tags & links features (#5736), answered by mock handlers
 * the conformance fixtures pin to the backend, so a broken frontend shows
 * here:
 *
 *   - the linked-references link-kind toggle (`list_backlinks_grouped`'s
 *     `kind`, pinned by `conformance/fixtures/block_ref_kind.json`);
 *   - a tag chip whose tag the resolve store never listed reading its name
 *     (`batch_resolve`, pinned by its `queries` step).
 */

/** `SEED_IDS` in `src/lib/tauri-mock/seed.ts`. */
const GETTING_STARTED = '00000000000000000000PAGE01'
const GS1 = '0000000000000000000B10CK01'

async function createTag(page: Page, name: string): Promise<string> {
  const { id } = await ipc<{ id: string }>(page, 'create_block', {
    blockType: 'tag',
    content: name,
    parentId: null,
    index: null,
    scope: { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL },
    blockId: null,
  })
  return id
}

test.describe('Linked references link kind @editor @pages', () => {
  test('All, Page links and Block refs narrow the list and the header count', async ({ page }) => {
    await waitForBoot(page)
    // Quick Notes' seeded QN_1 already page-links Getting Started; this adds
    // the block ref.
    await seedSearchBlocks(page, [{ content: `Block ref note ((${GETTING_STARTED}))` }])
    await openPage(page, 'Getting Started')

    const references = page.getByTestId('linked-references')
    const header = references.getByRole('button', { name: /^Collapse \d+ references?$/ })
    const rows = references.locator('[data-backlink-item]')
    const kind = (name: string) =>
      references
        .getByRole('radiogroup', { name: 'Filter by link kind', exact: true })
        .getByRole('radio', { name, exact: true })

    // Groups order by source-page title: Projects, then Quick Notes.
    await expect(header).toHaveText('2 references')
    await expect(rows).toHaveText([/^Block ref note/, /^These notes complement/])

    await kind('Page links').click()
    await expect(header).toHaveText('1 reference')
    await expect(rows).toHaveText([/^These notes complement/])

    await kind('Block refs').click()
    await expect(header).toHaveText('1 reference')
    await expect(rows).toHaveText([/^Block ref note/])

    await kind('All').click()
    await expect(header).toHaveText('2 references')
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
