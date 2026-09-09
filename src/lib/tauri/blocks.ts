import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { BlockRow, WithOps } from '@/lib/bindings'
import { toSpaceScope } from '@/lib/tauri/_shared'

/** Create a new block. Returns the created block with its generated ID.
 *
 * / H-3a — when `blockType === 'page'`, `spaceId` is REQUIRED.
 * The backend rejects page-typed creates without a space ULID with
 * `AppError::Validation`. For page creation, prefer the explicit
 * `createPageInSpace` helper below — it makes the invariant readable
 * at the callsite and routes through the dedicated `create_page_in_space`
 * IPC. The optional `spaceId` here exists so callers stuck on
 * `createBlock` can still satisfy the invariant if needed (and so the
 * specta-bound IPC parameter list matches the Rust signature).
 *
 * Other block types (`content`, `tag`) ignore `spaceId`.
 */
export async function createBlock(params: {
  blockType: string
  content: string
  parentId?: string | undefined
  /** #400: 0-based sibling slot among `parentId`'s children; omit to append. */
  index?: number | undefined
  spaceId?: string | undefined
  /**
   * #2849 PR2 — optional client-generated ULID for optimistic create. When
   * supplied it MUST be a well-formed ULID (see `newBlockId`): the backend uses
   * it verbatim and rejects a malformed or already-existing id. Omit to let the
   * backend mint a server id (all legacy callers).
   */
  blockId?: string | undefined
}): Promise<WithOps<BlockRow>> {
  return unwrap(
    await commands.createBlock(
      params.blockType,
      params.content,
      params.parentId ?? null,
      params.index ?? null,
      toSpaceScope(params.spaceId),
      params.blockId ?? null,
    ),
  )
}
