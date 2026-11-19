/**
 * The preamble every store-level Tauri-mock test file was re-spelling.
 *
 * #4036 item 3 / #4151 review item 6 — `id` / `clearMock` / `setSpace` were
 * duplicated character-for-character across three test files.
 * The cost is specific and has been paid before: a future store addition that
 * needs resetting has to be applied in every copy, and #3469's `peerRefs` is
 * the precedent for what happens when it is applied in one. One owner removes
 * the other places to forget.
 *
 * Not a `.test.ts` file, so vitest's `include` (`src/**\/*.{test,spec}.{ts,tsx}`)
 * does not try to run it as a suite.
 */

import {
  blockTags,
  blocks,
  fakeId,
  makeBlock,
  opLog,
  pageAliases,
  properties,
  propertyDefs,
  SEED_IDS,
  seedBlocks,
  stampPageLastEdited,
} from '@/lib/tauri-mock/seed'

/** A 26-character ULID-shaped id from a short readable label. */
export function id(label: string): string {
  return label.padStart(26, '0')
}

/**
 * Empty every mock store, leaving a blank slate for a hand-built fixture.
 *
 * `seedBlocks()` runs FIRST so the reset covers whatever that function
 * populates (it clears before it seeds), and the explicit `.clear()` calls
 * then drop the seed itself.
 *
 * `pageAliases` is one the three copies of this preamble had all missed — it
 * was seeded (`src/lib/tauri-mock/seed.ts:653`) and never cleared, so it survived every reset. It
 * was inert only for as long as no handler read it; `list_unlinked_references`
 * now does (#4036 item 1). This is the drift the extraction exists to prevent,
 * showing up on the very first store the extraction made it possible to fix in
 * one place.
 */
export function clearMock(): void {
  seedBlocks()
  blocks.clear()
  blockTags.clear()
  properties.clear()
  propertyDefs.clear()
  pageAliases.clear()
  opLog.length = 0
}

/** Put a page or tag in a space: its `blocks.space_id`, which `ownerSpaceOf` reads. */
export function setSpace(blockId: string, spaceId: string): void {
  const row = blocks.get(blockId)
  if (!row) throw new Error(`setSpace: no block '${blockId}'`)
  row['space_id'] = spaceId
}

/**
 * Add `count` pages "Bulk Page 001"… to Personal, each with one child block and
 * one op-log edit on the page: page i is edited `i - 1` hours ago, and the
 * edits are pushed newest first, so `opLog`'s array order is not
 * chronological. Written to the stores directly: the tests need those exact
 * stamps, which commands answered within one tick would tie.
 */
export function addBulkPages(count: number): void {
  for (let i = 1; i <= count; i++) {
    const pageId = fakeId()
    const title = `Bulk Page ${String(i).padStart(3, '0')}`
    blocks.set(pageId, {
      ...makeBlock(pageId, 'page', title, null, 100 + i),
      space_id: SEED_IDS.SPACE_PERSONAL,
    })
    const editedAt = new Date()
    editedAt.setHours(editedAt.getHours() - (i - 1))
    stampPageLastEdited(pageId, editedAt.toISOString())
    const childId = fakeId()
    blocks.set(childId, makeBlock(childId, 'content', `${title} body`, pageId, 0))
  }
}
