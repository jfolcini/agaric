import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import { expect, ipc, openPage, settleBackend, test, waitForBoot } from './helpers'

/**
 * #6545 — the block "Link it" links appears in the open page's Linked References without leaving
 * the page.
 *
 * "Link it" writes through `edit_block` straight from the Unlinked References panel, not through a
 * page store, and nothing in the frontend bumps the graph counter Linked References refetches on:
 * only the change feed's `structure` domain does, sent once the edit's background rebuilds have
 * run. The panel reads `block_links`, which only that rebuild fills, so this spec's bridge starts
 * every background batch a second late: a refetch before the rebuild would read the block as
 * unlinked and nothing would ask again. The spec never leaves the page, since a navigation would
 * refetch the panel by itself.
 */
test.use({ slowMaterializerMs: 1000 })

const SPACE = SEED_IDS.SPACE_PERSONAL
const TARGET = 'Feed target'
const NOTE = 'feed note'

test('"Link it" lists the block in Linked References without leaving the page @pages', async ({
  page,
}) => {
  await waitForBoot(page)
  const source = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: 'Feed source',
    spaceId: SPACE,
  })
  await ipc(page, 'create_page_in_space', { parentId: null, content: TARGET, spaceId: SPACE })
  await ipc(page, 'create_block', {
    blockType: 'content',
    content: `${NOTE} mentions ${TARGET}`,
    parentId: source,
    index: null,
    scope: { kind: 'active', space_id: SPACE },
    blockId: null,
  })
  // The mention is in the search index before the page lists its references.
  await settleBackend(page)

  await openPage(page, TARGET)
  const unlinked = page.getByTestId('unlinked-references')
  const linked = page.getByTestId('linked-references')
  await unlinked.locator('.unlinked-references-header').click()
  const row = unlinked.locator('.unlinked-reference-item').filter({ hasText: NOTE })
  await expect(row).toBeVisible()
  await expect(linked.getByText(NOTE)).toHaveCount(0)

  await row.locator('.link-it-button').click()

  await expect(linked.getByText(NOTE)).toBeVisible()
})
