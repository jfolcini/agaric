/**
 * The block a typed `[[Page#anchor]]` names on its page (#6033), as import's
 * `anchor_block` (`src-tauri/src/commands/pages/markdown.rs`) finds it: for
 * `^ULID` the block of that id, else the first block in document order whose
 * first line is an ATX heading of the anchor's text, compared case- and
 * whitespace-insensitively. `reference-tokens.vectors.json`'s `headingAnchors`
 * rows pin the comparison to Rust's. An Obsidian `^name` (not a ULID) never
 * names a block when typed: import drops those markers, so no block keeps one.
 */

import { unwrap } from '@/lib/app-error'
import { type BlockRow, commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { requireActiveScope } from '@/lib/space-scope'
import { buildFlatTree } from '@/lib/tree-utils'
import { useSpaceStore } from '@/stores/space'

/** Rust's `char::is_whitespace`, which its `trim` and `split_whitespace` read. */
const SPACE_RUN = /\p{White_Space}+/u

/** `obsidian_heading_text`: the text of `content`'s first line when it is an ATX heading. */
function headingText(content: string): string | undefined {
  const line = content.split('\n')[0] ?? ''
  const heading = /^#{1,6}[ \t](.*)$/su.exec(line.replace(/^\p{White_Space}+/u, ''))
  const text = heading?.[1]?.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
  return text === '' ? undefined : text
}

/** `normalize_heading_anchor`. */
function normalizeHeadingAnchor(s: string): string {
  return s
    .split(SPACE_RUN)
    .filter((word) => word !== '')
    .join(' ')
    .toLowerCase()
}

/** The block `anchor` names among `blocks`, the subtree of page `pageId`. */
export function anchorBlockIn(
  blocks: BlockRow[],
  pageId: string,
  anchor: string,
): string | undefined {
  const ordered = buildFlatTree(blocks, pageId)
  if (anchor.startsWith('^') && anchor.length > 1) {
    return ordered.find((block) => block.id === anchor.slice(1))?.id
  }
  const key = normalizeHeadingAnchor(anchor)
  return ordered.find((block) => {
    const text = headingText(block.content ?? '')
    return text !== undefined && normalizeHeadingAnchor(text) === key
  })?.id
}

/** The block `anchor` names on page `pageId` in the active space; none when the page cannot load. */
export async function findAnchorBlock(pageId: string, anchor: string): Promise<string | undefined> {
  const spaceId = useSpaceStore.getState().currentSpaceId
  if (spaceId === null) return undefined
  try {
    const { blocks } = unwrap(await commands.loadPageSubtree(pageId, requireActiveScope(spaceId)))
    return anchorBlockIn(blocks, pageId, anchor)
  } catch (err) {
    logger.warn('anchor-block', 'could not load the page an anchor names', { pageId }, err)
    return undefined
  }
}
