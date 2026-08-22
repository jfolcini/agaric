/**
 * The preamble every store-level Tauri-mock test file was re-spelling.
 *
 * #4036 item 3 / #4151 review item 6 — `id` / `clearMock` / `setSpace` were
 * duplicated character-for-character across `search-fts-strip.test.ts`,
 * `links-fts-strip.test.ts` and `search-blocks-partitioned-residuals.test.ts`.
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
  opLog,
  pageAliases,
  properties,
  propertyDefs,
  seedBlocks,
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

/** Put a block in a space, the way `fbqInSpace` / `inSpaceScope` read it — a
 *  `space` property whose `value_ref` is the space id. */
export function setSpace(blockId: string, spaceId: string): void {
  if (!properties.has(blockId)) properties.set(blockId, new Map())
  properties.get(blockId)?.set('space', {
    key: 'space',
    value_text: null,
    value_num: null,
    value_date: null,
    value_ref: spaceId,
    value_bool: null,
  })
}
