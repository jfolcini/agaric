import { useCallback, useEffect, useState } from 'react'

import { notify } from '@/lib/notify'

import { i18n } from '../lib/i18n'
import { logger } from '../lib/logger'
import type { BlockRow } from '../lib/tauri'
import {
  addTag,
  createBlock,
  listBlocks,
  listInheritedTagsForBlock,
  listTagsForBlock,
  removeTag,
} from '../lib/tauri'
import { usePageBlockStoreApi } from '../stores/page-blocks'
import { useResolveStore } from '../stores/resolve'
import { useSpaceStore } from '../stores/space'
import { useUndoStore } from '../stores/undo'

export interface TagEntry {
  id: string
  name: string
  /**
   * #1423 — true when this tag reaches the block via inheritance
   * (`block_tag_inherited`) rather than a direct association. Inherited
   * (derived) chips render distinctly and are not directly removable. A
   * tag applied directly always wins over an inherited copy, so this is
   * only ever set for tags NOT in the direct set.
   */
  inherited?: boolean
}

export interface UseBlockTagsReturn {
  /** All available tags in the system */
  allTags: TagEntry[]
  /** Set of tag IDs applied directly to the current block (`block_tags`) */
  appliedTagIds: Set<string>
  /**
   * #1423 — set of tag IDs reaching the block via inheritance
   * (`block_tag_inherited`), excluding any tag that is also applied
   * directly (direct wins).
   */
  inheritedTagIds: Set<string>
  /** Loading state for initial tag fetch */
  loading: boolean
  /** Add an existing tag to the block */
  handleAddTag: (tagId: string) => Promise<void>
  /** Remove a tag from the block */
  handleRemoveTag: (tagId: string) => Promise<void>
  /** Create a new tag and optionally apply it to the block */
  handleCreateTag: (name: string) => Promise<void>
}

export function useBlockTags(blockId: string | null): UseBlockTagsReturn {
  const pageStore = usePageBlockStoreApi()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const [allTags, setAllTags] = useState<TagEntry[]>([])
  const [appliedTagIds, setAppliedTagIds] = useState<Set<string>>(new Set())
  const [inheritedTagIds, setInheritedTagIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)

  // Load all available tags for the active space.
  // #2248 — `listBlocks` requires an active space; there is no cross-space
  // listing. With no active space, short-circuit to an empty tag list rather
  // than invoking (which would throw in `requireActiveScope`).
  useEffect(() => {
    // #1518 — guard against a stale space's tag list resolving last and
    // clobbering the active space (cross-space leak). `cancelled` covers
    // the unmount / dep-change case; the `getState()` re-check additionally
    // defends a fast switch-back where the same in-flight run is stale but
    // its cleanup hasn't fired yet (the captured id no longer matches the
    // live store).
    let cancelled = false
    const capturedSpaceId = currentSpaceId
    if (!capturedSpaceId) {
      setAllTags([])
      return
    }
    listBlocks({ blockType: 'tag', spaceId: capturedSpaceId })
      .then((resp) => {
        if (cancelled) return
        if (useSpaceStore.getState().currentSpaceId !== capturedSpaceId) return
        setAllTags(resp.items.map((t: BlockRow) => ({ id: t.id, name: t.content ?? '' })))
      })
      .catch((error) => {
        if (cancelled) return
        logger.error('useBlockTags', 'Failed to load all tags', undefined, error)
        notify.error(i18n.t('tags.loadFailed'), { id: 'tags-load-failed' })
      })
    return () => {
      cancelled = true
    }
  }, [currentSpaceId])

  // Load applied + inherited tags when blockId changes (#1423).
  // Direct (`block_tags`) and inherited (`block_tag_inherited`) tags are
  // fetched in parallel; a tag present in BOTH is treated as direct only
  // (direct wins, since a direct tag is removable) so it never renders as
  // a derived chip.
  useEffect(() => {
    // #1518 — guard against an older block's tags resolving last and
    // overwriting the newer block after a fast blockId switch. `cancelled`
    // is tripped by the cleanup on every dep change / unmount, so any
    // in-flight response for the previous blockId is dropped.
    let cancelled = false
    setAppliedTagIds(new Set())
    setInheritedTagIds(new Set())
    setLoading(true)
    if (blockId) {
      Promise.all([listTagsForBlock(blockId), listInheritedTagsForBlock(blockId)])
        .then(([directIds, inheritedIds]) => {
          if (cancelled) return
          const direct = new Set(directIds)
          setAppliedTagIds(direct)
          setInheritedTagIds(new Set(inheritedIds.filter((id) => !direct.has(id))))
          setLoading(false)
        })
        .catch((error) => {
          if (cancelled) return
          logger.error('useBlockTags', 'Failed to load tags for block', { blockId }, error)
          notify.error(i18n.t('tags.loadFailed'), { id: 'tags-load-failed' })
          setLoading(false)
        })
    } else {
      setLoading(false)
    }
    return () => {
      cancelled = true
    }
  }, [blockId])

  const handleAddTag = useCallback(
    async (tagId: string) => {
      if (!blockId) return
      try {
        const resp = await addTag(blockId, tagId)
        const { rootParentId } = pageStore.getState()
        // #2468 — thread the appended op ref(s) so undo is ref-addressed.
        // `op_refs` is EMPTY on an idempotent no-op (tag already attached):
        // nothing was appended, so do NOT push an undo entry — and don't
        // invalidate redo history for an action that changed nothing.
        if (rootParentId && resp.op_refs.length > 0) {
          useUndoStore.getState().onNewAction(rootParentId, resp.op_refs)
        }
        setAppliedTagIds((prev) => new Set([...prev, tagId]))
        // Adding an inherited-only tag directly promotes it to a direct tag;
        // drop it from the inherited set so it doesn't render as a duplicate
        // chip (same React key) until the next blockId-change refetch (#1423).
        setInheritedTagIds((prev) => {
          if (!prev.has(tagId)) return prev
          const next = new Set(prev)
          next.delete(tagId)
          return next
        })
      } catch (error) {
        logger.error('useBlockTags', 'Failed to add tag', { blockId, tagId }, error)
        notify.error(i18n.t('tags.addFailed'))
      }
    },
    [blockId, pageStore],
  )

  const handleRemoveTag = useCallback(
    async (tagId: string) => {
      if (!blockId) return
      try {
        const resp = await removeTag(blockId, tagId)
        const { rootParentId } = pageStore.getState()
        // #2468 — see handleAddTag: skip the undo push on an idempotent
        // no-op (`op_refs` empty — the tag was not attached).
        if (rootParentId && resp.op_refs.length > 0) {
          useUndoStore.getState().onNewAction(rootParentId, resp.op_refs)
        }
        setAppliedTagIds((prev) => {
          const next = new Set(prev)
          next.delete(tagId)
          return next
        })
      } catch (error) {
        logger.error('useBlockTags', 'Failed to remove tag', { blockId, tagId }, error)
        notify.error(i18n.t('tags.deleteFailed'))
      }
    },
    [blockId, pageStore],
  )

  const handleCreateTag = useCallback(
    async (name: string) => {
      const trimmed = name.trim()
      if (!trimmed) return
      try {
        const resp = await createBlock({ blockType: 'tag', content: trimmed })
        const entry = { id: resp.id, name: trimmed }
        setAllTags((prev) => [...prev, entry])
        useResolveStore.getState().set(resp.id, trimmed, false)
        if (blockId) {
          const tagResp = await addTag(blockId, resp.id)
          const { rootParentId } = pageStore.getState()
          // #2468 — see handleAddTag (a just-created tag can't already be
          // attached, but honor the empty-refs no-op contract regardless).
          if (rootParentId && tagResp.op_refs.length > 0) {
            useUndoStore.getState().onNewAction(rootParentId, tagResp.op_refs)
          }
          setAppliedTagIds((prev) => new Set([...prev, resp.id]))
        }
      } catch (error) {
        logger.error('useBlockTags', 'Failed to create tag', { blockId, name: trimmed }, error)
        notify.error(i18n.t('tags.createFailed'))
      }
    },
    [blockId, pageStore],
  )

  return {
    allTags,
    appliedTagIds,
    inheritedTagIds,
    loading,
    handleAddTag,
    handleRemoveTag,
    handleCreateTag,
  }
}
