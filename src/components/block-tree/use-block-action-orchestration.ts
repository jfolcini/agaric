import type { TFunction } from 'i18next'
import type { RefObject } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'

import { consumePendingSplit } from '@/components/block-tree/use-block-flush'
import { shouldSplitOnBlur } from '@/editor/content-delta'
import { parse } from '@/editor/markdown-serializer'
import type { DocNode } from '@/editor/types'
import { pmEndOfFirstBlock } from '@/editor/types'
import type { DeleteBlockOpts } from '@/editor/use-block-keyboard'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { announce } from '@/lib/announcer'
import type { ListStyle } from '@/lib/list-style'
import { clearListStyle, setListStyle } from '@/lib/list-style'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import type { FlatBlock } from '@/lib/tree-utils'
import type { MountedBlocks } from '@/lib/zoom-scope'
import type { usePageBlockStoreApi } from '@/stores/page-blocks'

/**
 * Scroll the block's DOM node into view after a reorder so the
 * viewport tracks the moved block instead of jumping to the top. Wrapped
 * in requestAnimationFrame to let React commit the new layout before we
 * read it. Uses `block: 'nearest'` (not smooth, not center) to keep
 * already-visible blocks in place and only pull off-screen blocks into view.
 *
 * Silently no-ops when the DOM node is absent (e.g. virtualised away or
 * still being remounted by the roving editor).
 */
function scrollFocusedBlockIntoView(blockId: string): void {
  requestAnimationFrame(() => {
    document.querySelector(`[data-block-id="${blockId}"]`)?.scrollIntoView({ block: 'nearest' })
  })
}

/**
 * R6 (#405): announce a move's REAL outcome once the store action resolves.
 * The store resolves `true` on a committed move and `false` on a no-op
 * (boundary reached) or a caught backend error (which also toasts). Announcing
 * synchronously before the promise settled meant assistive tech reported a
 * phantom "moved" even when nothing changed. Runs `onSuccess` (e.g. scroll)
 * only on a real move.
 */
function announceMoveResult(
  result: Promise<boolean>,
  t: TFunction,
  successKey: string,
  onSuccess?: () => void,
): Promise<void> {
  return result
    .then((ok) => {
      announce(t(ok ? successKey : 'announce.moveFailed'))
      if (ok) onSuccess?.()
    })
    .catch(() => {
      announce(t('announce.moveFailed'))
    })
}

/**
 * #921 f2 — Backspace-at-start merge must not let the current block's text
 * re-parse as a NEW block construct once it is concatenated onto the previous
 * block's paragraph.
 *
 * The merge stores `prevContent + currentContent` as the previous block's
 * markdown. If `currentContent` begins with a LEADING block-markdown token
 * (`- bar`, `# h`, `> q`, `1. x`, `- [ ] task`), a plain concat would turn the
 * joined-in text into a list item / heading / blockquote appended to (or
 * absorbing) the previous paragraph — mangling the markup. Backspace at the
 * start of a block is a textual join, so the leading construct marker should be
 * dropped and only its inline text carried over.
 *
 * This strips exactly ONE leading block-marker from the FIRST line so the
 * joined content stays inline. It is intentionally conservative: it only fires
 * when the previous block is non-empty (a real join) and only touches the
 * leading token — interior lines and inline marks (`**bold**`, `_em_`) are
 * untouched.
 */
const LEADING_BLOCK_MARKER_RE =
  /^(?:\s{0,3})(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d{1,9}[.)]\s+)/

export function stripLeadingBlockMarker(content: string): string {
  // Operate only on the first line so a multi-line current block keeps its
  // remaining structure; the join only affects where it meets the prev block.
  const newlineIdx = content.indexOf('\n')
  const firstLine = newlineIdx === -1 ? content : content.slice(0, newlineIdx)
  const rest = newlineIdx === -1 ? '' : content.slice(newlineIdx)
  const stripped = firstLine.replace(LEADING_BLOCK_MARKER_RE, '')
  // Only rewrite when a marker was actually present (avoid mangling plain text
  // and avoid trimming legitimate leading whitespace on unmarked lines).
  return stripped === firstLine ? content : stripped + rest
}

/**
 * Build the merged markdown for a Backspace-at-start join: the previous
 * block's content followed by the current block's content with any leading
 * block-construct marker neutralized (see {@link stripLeadingBlockMarker}).
 * When the previous block is empty there is no paragraph to absorb the text,
 * so the current content is carried over verbatim (nothing to mangle).
 */
function joinMergedContent(prevContent: string, currentContent: string): string {
  if (prevContent === '') return currentContent
  return prevContent + stripLeadingBlockMarker(currentContent)
}

/**
 * Node types a Backspace-at-start merge must NOT textually join into. The
 * merge stores `prevContent + currentContent`; when the previous block's
 * markdown ENDS in one of these verbatim constructs, the appended raw text
 * corrupts the construct instead of joining after it:
 *   - code fence: '```js\ncode\n```' + 'text' leaves the fence unclosed
 *     ('```text' fails the closing-fence regex), swallowing the text into the
 *     code block — and the next serialize canonicalizes the corruption.
 *   - math block: '$$\nE=mc^2\n$$' + 'text' degrades to plain paragraphs.
 *   - divider: '---' + 'text' re-parses as the paragraph '---text'.
 *   - table: the appended text breaks the last row's shape.
 * The #725 keyboard guard only inspects the CURRENT editor's node type, so a
 * plain paragraph merging INTO one of these still reached the join.
 */
const VERBATIM_MERGE_TARGET_TYPES = new Set(['codeBlock', 'table', 'math_block', 'horizontalRule'])

/**
 * True when the previous block's parsed markdown ends in a verbatim construct
 * (see {@link VERBATIM_MERGE_TARGET_TYPES}). The merge handlers treat this as
 * a no-op join — keep both blocks, only move the caret (Logseq behaviour
 * against code blocks) — because there is no safe textual concatenation.
 */
function endsInVerbatimBlock(prevDoc: DocNode): boolean {
  const last = prevDoc.content?.at(-1)
  return last != null && VERBATIM_MERGE_TARGET_TYPES.has(last.type)
}

/**
 * #1342 — plan the reparent of a merged-away block's children onto the merge
 * target. Reads the FULL flat tree (`blocks`) — `collapsedVisible` hides a
 * collapsed source's children, so this must not use the visible projection.
 *
 * Returns the source block's DIRECT children, in document order, and the
 * target slot (`newIndex`) at which to land them: the merge target's current
 * direct-child count, so the children are appended AFTER any children the
 * target already has — matching the Logseq/Workflowy backspace-merge where the
 * absorbed block's children become the tail of the survivor's children.
 *
 * Returns `null` when the source has no children (the merge is a plain
 * childless join — no reparent needed). Each direct child is a "selection
 * root" (none is a descendant of another), so `moveBlocks` carries each one's
 * own subtree along, preserving the full nested structure.
 */
function planChildReparent(
  blocks: FlatBlock[],
  sourceId: string,
  targetId: string,
): { childIds: string[]; newIndex: number } | null {
  const childIds = blocks.filter((b) => (b.parent_id ?? null) === sourceId).map((b) => b.id)
  if (childIds.length === 0) return null
  const newIndex = blocks.filter((b) => (b.parent_id ?? null) === targetId).length
  return { childIds, newIndex }
}

export interface UseBlockActionOrchestrationParams {
  focusedBlockId: string | null
  /**
   * The ACTIVE view projection, in rendered document order — every neighbour
   * lookup in this hook (focus prev/next, the Backspace merge target, the
   * delete boundary guard and its post-delete refocus) walks it, so it must
   * contain exactly the rows `BlockListRenderer` mounts.
   *
   * #3344/#3641 — brand-gated (`MountedBlocks`): #3251 was this parameter being handed
   * the un-zoomed page list, which typechecked because both lists were
   * `FlatBlock[]`. Only `useBlockZoom` derives this type, so the page-wide list
   * is no longer a legal argument here.
   */
  collapsedVisible: MountedBlocks
  /**
   * #1342 — the FULL flat tree (not the collapsed/visible projection). The
   * merge handlers need it to find the merged-away block's DIRECT children
   * (which `collapsedVisible` hides when the source is collapsed) so they can
   * be reparented onto the merge target instead of soft-deleted by the
   * backend's `delete_block` cascade.
   */
  blocks: FlatBlock[]
  /**
   * #4959 — mount the first row past the mount cap and return it (`null` when
   * none). `collapsedVisible` stops AT the cap, so ArrowDown on the last mounted
   * row was a dead end. A callback rather than the uncapped list keeps the
   * `MountedBlocks` brand gate intact. Optional: callers with no cap omit it.
   */
  revealNextMounted?: () => FlatBlock | null
  rovingEditor: Pick<
    RovingEditorHandle,
    | 'editor'
    | 'activeBlockId'
    | 'mount'
    | 'updateListMarker'
    | 'listMarker'
    | 'unmount'
    | 'getMarkdown'
    | 'splitAtCaret'
  >
  setFocused: (id: string | null) => void
  handleFlush: () => string | null
  /**
   * #4957 — page store API, read for the post-flush remount baseline (see
   * {@link useBlockActionOrchestration}'s `remountBaseline`).
   */
  pageStore: ReturnType<typeof usePageBlockStoreApi>
  remove: (id: string) => Promise<void>
  /**
   * #1342 — reparent a contiguous run of blocks (in document order) under a
   * new parent, landing at the given 0-based sibling slot. Used by the merge
   * handlers to move the merged-away block's children onto the merge target
   * before the source block is removed. Same action the multi-select drag
   * uses; it issues one `move_block` per block and reloads the tree.
   */
  moveBlocks: (ids: string[], newParentId: string | null, newIndex: number) => Promise<void>
  edit: (id: string, content: string) => Promise<boolean>
  indent: (id: string) => Promise<boolean>
  dedent: (id: string) => Promise<boolean>
  moveUp: (id: string) => Promise<boolean>
  moveDown: (id: string) => Promise<boolean>
  createBelow: (afterBlockId: string, content?: string) => Promise<string | null>
  justCreatedBlockIds: RefObject<Set<string>>
  /**
   * #4729 — ids BlockTree's leaked-empty-block cleanup must skip exactly once.
   *
   * Enter pressed at the START of a block splits it into `before = ''` and
   * `after = <the whole line>`: the source block keeps its slot and is left
   * deliberately EMPTY, the text moves into a new sibling below, and focus
   * follows the text. That empty source is the user's blank line, so the
   * focus-leave cleanup must not treat it as a leak — otherwise Enter-at-line-
   * start becomes a visible no-op. Registered here BEFORE the split's first
   * await (a click elsewhere during the `edit`/`createBelow` round trip moves
   * focus off the already-emptied source, and the cleanup must find the
   * exemption in place by then), consumed (and cleared) by the cleanup effect
   * on the next focus change, and withdrawn on the split's failure paths,
   * which restore the source's full content.
   *
   * Optional: callers that never drive a caret split (isolated hook tests) may
   * omit it.
   */
  preserveEmptyBlockIds?: RefObject<Set<string>>
  /**
   * Discard any persisted draft for the given block. Called on Escape, and
   * (#2786) after a successful caret-split `edit()` to drop the departed
   * block's now-stale pre-split draft row.
   */
  discardDraft: (blockId: string) => void
  t: TFunction
}

export interface UseBlockActionOrchestrationReturn {
  handleFocusPrev: () => void
  handleFocusNext: () => void
  handleDeleteBlock: (opts?: DeleteBlockOpts) => void
  handleIndent: () => void
  handleDedent: () => void
  handleMoveUp: () => void
  handleMoveDown: () => void
  handleIndentById: (id: string) => Promise<void>
  handleDedentById: (id: string) => Promise<void>
  handleMoveUpById: (id: string) => Promise<void>
  handleMoveDownById: (id: string) => Promise<void>
  handleMergeWithPrev: () => Promise<void>
  handleMergeById: (blockId: string) => Promise<void>
  handleEnterSave: () => Promise<void>
  handleEscapeCancel: () => void
}

export function useBlockActionOrchestration({
  focusedBlockId,
  collapsedVisible,
  blocks,
  revealNextMounted,
  rovingEditor,
  setFocused,
  handleFlush,
  pageStore,
  remove,
  moveBlocks,
  edit,
  indent,
  dedent,
  moveUp,
  moveDown,
  createBelow,
  justCreatedBlockIds,
  preserveEmptyBlockIds,
  discardDraft,
  t,
}: UseBlockActionOrchestrationParams): UseBlockActionOrchestrationReturn {
  const rovingEditorRef = useRef(rovingEditor)
  useLayoutEffect(() => {
    rovingEditorRef.current = rovingEditor
  })

  // Tracks the post-merge setTextSelection setTimeout so we can cancel it on
  // unmount. Without this, a late-firing callback could call
  // `setTextSelection` on a stale editor instance and move the user's cursor
  // On the NEXT mounted block (#).
  const pendingMergeSelectionRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (pendingMergeSelectionRef.current !== null) {
        window.clearTimeout(pendingMergeSelectionRef.current)
        pendingMergeSelectionRef.current = null
      }
    },
    [],
  )

  // Re-entrancy guard: prevents rapid Backspace presses from duplicating deletes.
  const deleteInProgress = useRef(false)

  // Re-entrancy guard: prevents rapid Enter presses from creating duplicate blocks.
  const enterSaveInProgress = useRef(false)

  // Re-entrancy guard for merges: handleMergeWithPrev/handleMergeById unmount
  // the roving editor (resetting its doc to empty) BEFORE awaiting the edit
  // IPC, so an autorepeat Backspace in that window matches the
  // Backspace-on-empty rule and an Enter matches the create rule — both on
  // the block that is being merged away. handleDeleteBlock/handleEnterSave
  // honor this flag so no concurrent structural op races the merge.
  const mergeInProgress = useRef(false)

  // #4552 slice 3 — the style `continueListStyle` just wrote to a freshly
  // created sibling, held only until the marker catches up.
  //
  // The marker cannot answer for that block yet: `mount()` resets it to
  // `'none'` (#3000) and the new `EditableBlock`'s effect re-pushes
  // `ListMarkerContext`'s value, which stays empty until `set_property` →
  // `block:properties-changed` → the 150 ms trailing debounce in
  // `block-property-events.ts` → the batch refetch lands. Enter → Enter is the
  // ordinary "leave the list" gesture and lands well inside that window, so
  // without this the second Enter read `'none'`, took the plain `createBelow`
  // path, and left a stray empty styled item with an unstyled block under it
  // — which `empty-block-cleanup.ts` guard 5 then keeps forever.
  const optimisticListStyle = useRef<{ blockId: string; style: ListStyle } | null>(null)

  // #4552 slice 3 — the list style the focused editor is showing, read through
  // the roving handle (what `EditableBlock` pushed from `ListMarkerContext`).
  // This hook mounts above the property batch provider, so that is its only
  // synchronous source; going through the handle keeps `BlockTree`'s eager
  // import graph free of TipTap (#2939).
  //
  // Reading also EXPIRES a spent optimistic entry, which is what bounds it:
  // once focus has left the block it was recorded for, or the marker shows any
  // style at all, the marker is authoritative again. Without that expiry a
  // later Turn-into (which clears `listStyle` through paths this hook never
  // sees — `use-block-tree-event-listeners.ts`, `useSlashCommandStructural`)
  // would leave the entry answering for a block that is no longer a list item.
  // The one window it cannot cover is a style CLEARED before the marker ever
  // showed it — under ~250 ms after the Enter that created the block, which no
  // menu or slash command is reachable in.
  const focusedListStyle = useCallback((): ListStyle => {
    const shown = rovingEditorRef.current.listMarker().style
    const optimistic = optimisticListStyle.current
    if (!optimistic) return shown
    if (optimistic.blockId !== rovingEditorRef.current.activeBlockId || shown !== 'none') {
      optimisticListStyle.current = null
      return shown
    }
    return optimistic.style
  }, [])

  // The "leave the list" half of the gesture: Backspace at line start and
  // Enter on an empty styled block both clear the style and do nothing
  // structural. The marker is cleared locally FIRST so the next keystroke
  // reads a plain block and merges / deletes / splits, instead of clearing a
  // second time while the property-event refetch is still in its debounce.
  const clearFocusedListStyle = useCallback(
    async (blockId: string): Promise<void> => {
      const cleared = rovingEditorRef.current.listMarker()
      const clearedOptimistic = optimisticListStyle.current
      optimisticListStyle.current = null
      rovingEditorRef.current.updateListMarker('none', undefined)
      try {
        await clearListStyle(blockId)
      } catch (err) {
        // Put back exactly what was cleared. The property row is still in
        // SQLite, so `useListStyles` projects the same map as before and
        // `EditableBlock`'s marker effect never re-fires — left alone the
        // block would render AND behave as plain while it is still a list
        // item, until some unrelated property change forced a refetch.
        if (rovingEditorRef.current.activeBlockId === blockId) {
          rovingEditorRef.current.updateListMarker(cleared.style, cleared.ordinal)
          optimisticListStyle.current = clearedOptimistic
        }
        logger.error('useBlockActionOrchestration', 'clearListStyle failed', { blockId }, err)
        notify.error(t('blockTree.clearListStyleFailed'))
      }
    },
    [t],
  )

  // The "continue the list" half: the sibling Enter created carries the
  // source block's style, so a numbered procedure keeps numbering without
  // any inheritance from a parent.
  const continueListStyle = useCallback(
    async (newBlockId: string, style: ListStyle): Promise<void> => {
      if (style === 'none') return
      // Recorded BEFORE the write, not after: the gesture this exists for is a
      // second Enter, which lands while the write is still in flight. Dropped
      // on failure so a rejected write cannot leave the keyboard grain acting
      // on a list the block never joined.
      optimisticListStyle.current = { blockId: newBlockId, style }
      try {
        await setListStyle(newBlockId, style)
      } catch (err) {
        if (optimisticListStyle.current?.blockId === newBlockId) {
          optimisticListStyle.current = null
        }
        logger.error(
          'useBlockActionOrchestration',
          'setListStyle (Enter continuation) failed',
          { blockId: newBlockId, style },
          err,
        )
        notify.error(t('blockTree.setListStyleFailed'))
      }
    },
    [t],
  )

  const handleFocusPrev = useCallback(() => {
    const idx = collapsedVisible.findIndex((b) => b.id === focusedBlockId)
    if (idx > 0) {
      const prevBlock = collapsedVisible[idx - 1] as (typeof collapsedVisible)[number]
      setFocused(prevBlock.id)
      rovingEditorRef.current.mount(prevBlock.id, prevBlock.content ?? '')
      const preview = prevBlock.content?.slice(0, 50) ?? ''
      announce(t('announce.editingBlock', { preview: preview || t('announce.emptyBlock') }))
    }
  }, [collapsedVisible, focusedBlockId, setFocused, t])

  const handleFocusNext = useCallback(() => {
    const idx = collapsedVisible.findIndex((b) => b.id === focusedBlockId)
    if (idx < 0) return
    // #4959 — at the last MOUNTED row, reveal the row past the mount cap and
    // step onto it; the reveal and the focus batch into one render, so the row
    // mounts already focused.
    const nextBlock: FlatBlock | null | undefined =
      idx < collapsedVisible.length - 1 ? collapsedVisible[idx + 1] : revealNextMounted?.()
    if (!nextBlock) return
    setFocused(nextBlock.id)
    rovingEditorRef.current.mount(nextBlock.id, nextBlock.content ?? '')
    const preview = nextBlock.content?.slice(0, 50) ?? ''
    announce(t('announce.editingBlock', { preview: preview || t('announce.emptyBlock') }))
  }, [collapsedVisible, focusedBlockId, revealNextMounted, setFocused, t])

  const handleDeleteBlock = useCallback(
    (opts?: DeleteBlockOpts) => {
      if (!focusedBlockId) return
      if (deleteInProgress.current) return
      // An in-flight merge has already unmounted the roving editor (its doc is
      // empty), so an autorepeat Backspace routes here for the very block the
      // merge is removing — bail instead of racing a second remove().
      if (mergeInProgress.current) return
      // #4552 slice 3 — Backspace on an empty styled block leaves the list
      // first; the next Backspace deletes the block.
      if (focusedListStyle() !== 'none') {
        void clearFocusedListStyle(focusedBlockId)
        return
      }
      if (collapsedVisible.length <= 1) {
        notify.error(t('blockTree.cannotDeleteLastBlock'))
        return
      }
      const idx = collapsedVisible.findIndex((b) => b.id === focusedBlockId)
      const prevBlock =
        idx > 0 ? (collapsedVisible[idx - 1] as (typeof collapsedVisible)[number]) : null
      // #4958 — a blank block WITH children reads as empty to the roving editor,
      // and the backend delete cascades, so reparent the children first exactly
      // as the merge handlers do (#1342). Planned from the FULL tree: the
      // collapsed projection hides a collapsed block's children.
      if (!prevBlock && blocks.some((b) => (b.parent_id ?? null) === focusedBlockId)) {
        // Nothing above to adopt them: the delete does not proceed, mirroring
        // the merge handlers' `idx <= 0` bail.
        return
      }
      const reparent = prevBlock ? planChildReparent(blocks, focusedBlockId, prevBlock.id) : null
      deleteInProgress.current = true
      rovingEditorRef.current.unmount()
      const removal =
        prevBlock && reparent
          ? moveBlocks(reparent.childIds, prevBlock.id, reparent.newIndex).then(() =>
              remove(focusedBlockId),
            )
          : remove(focusedBlockId)
      removal
        .catch((err: unknown) => {
          // The store toasts its own delete failure; this catch exists for the
          // BlockTree verifying wrapper (which THROWS when the block is still
          // present after remove) so the rejection doesn't go unhandled.
          logger.warn(
            'useBlockActionOrchestration',
            'Failed to delete block',
            { blockId: focusedBlockId },
            err,
          )
        })
        .finally(() => {
          deleteInProgress.current = false
        })
      announce(t('announce.blockDeleted'))
      if (prevBlock) {
        setFocused(prevBlock.id)
        // #752 — honour the caller's cursor-placement hint (Backspace on an
        // empty block lands the caret at the END of the previous block, the
        // way a plain-text backspace would).
        rovingEditorRef.current.mount(prevBlock.id, prevBlock.content ?? '', {
          cursorPlacement: opts?.cursorPlacement,
        })
      } else if (idx + 1 < collapsedVisible.length) {
        // Deleting the FIRST block focuses the NEXT one. The 'end' hint is
        // intentionally NOT applied here: the caret belongs at the default
        // (start) position when focus moves forward.
        const nextBlock = collapsedVisible[idx + 1] as (typeof collapsedVisible)[number]
        setFocused(nextBlock.id)
        rovingEditorRef.current.mount(nextBlock.id, nextBlock.content ?? '')
      } else {
        setFocused(null)
      }
    },
    [
      focusedBlockId,
      collapsedVisible,
      blocks,
      moveBlocks,
      remove,
      setFocused,
      t,
      focusedListStyle,
      clearFocusedListStyle,
    ],
  )

  /**
   * #4957 — what the restructure handlers remount with after `handleFlush()`.
   * A multi-block capture was split: `splitBlock` wrote line 1 into the store
   * synchronously, so remounting the full capture would re-commit lines 2..N
   * that now exist as siblings. The `?? captured` covers a block another page's
   * store owns (#4550 embeds), which the flush leaves unsplit.
   */
  const remountBaseline = useCallback(
    (blockId: string, captured: string): string =>
      shouldSplitOnBlur(captured)
        ? (pageStore.getState().blocksById.get(blockId)?.content ?? captured)
        : captured,
    [pageStore],
  )

  const handleIndent = useCallback(() => {
    if (!focusedBlockId) return
    const blockId = focusedBlockId
    const content = rovingEditorRef.current.getMarkdown?.() ?? ''
    handleFlush()
    // R6 (#405): announce on RESOLUTION so assistive tech reports the real
    // outcome — a no-op (already at outermost level) or a backend rejection
    // must not announce a phantom "indented".
    void announceMoveResult(indent(blockId), t, 'announce.blockIndented')
    rovingEditorRef.current.mount(blockId, remountBaseline(blockId, content))
  }, [focusedBlockId, handleFlush, indent, remountBaseline, t])

  const handleDedent = useCallback(() => {
    if (!focusedBlockId) return
    const blockId = focusedBlockId
    const content = rovingEditorRef.current.getMarkdown?.() ?? ''
    handleFlush()
    void announceMoveResult(dedent(blockId), t, 'announce.blockDedented')
    rovingEditorRef.current.mount(blockId, remountBaseline(blockId, content))
  }, [focusedBlockId, handleFlush, dedent, remountBaseline, t])

  const handleMoveUp = useCallback(() => {
    if (!focusedBlockId) return
    const content = rovingEditorRef.current.getMarkdown?.() ?? ''
    handleFlush()
    const blockId = focusedBlockId
    // R6 (#405): announce + scroll on RESOLUTION — a boundary no-op or backend
    // rejection must not announce a phantom "moved up".
    void announceMoveResult(moveUp(blockId), t, 'announce.blockMovedUp', () =>
      scrollFocusedBlockIntoView(blockId),
    )
    rovingEditorRef.current.mount(blockId, remountBaseline(blockId, content))
  }, [focusedBlockId, handleFlush, moveUp, remountBaseline, t])

  const handleMoveDown = useCallback(() => {
    if (!focusedBlockId) return
    const content = rovingEditorRef.current.getMarkdown?.() ?? ''
    handleFlush()
    const blockId = focusedBlockId
    void announceMoveResult(moveDown(blockId), t, 'announce.blockMovedDown', () =>
      scrollFocusedBlockIntoView(blockId),
    )
    rovingEditorRef.current.mount(blockId, remountBaseline(blockId, content))
  }, [focusedBlockId, handleFlush, moveDown, remountBaseline, t])

  const handleIndentById = useCallback(
    (id: string) => {
      const content = id === focusedBlockId ? (rovingEditorRef.current.getMarkdown?.() ?? '') : null
      handleFlush()
      const result = announceMoveResult(
        indent(id).catch((err: unknown) => {
          logger.warn('useBlockActionOrchestration', 'indent by id failed', { blockId: id }, err)
          throw err instanceof Error ? err : new Error(String(err))
        }),
        t,
        'announce.blockIndented',
      )
      if (content !== null) {
        rovingEditorRef.current.mount(id, remountBaseline(id, content))
      }
      return result
    },
    [focusedBlockId, handleFlush, indent, remountBaseline, t],
  )

  const handleDedentById = useCallback(
    (id: string) => {
      const content = id === focusedBlockId ? (rovingEditorRef.current.getMarkdown?.() ?? '') : null
      handleFlush()
      const result = announceMoveResult(
        dedent(id).catch((err: unknown) => {
          logger.warn('useBlockActionOrchestration', 'dedent by id failed', { blockId: id }, err)
          throw err instanceof Error ? err : new Error(String(err))
        }),
        t,
        'announce.blockDedented',
      )
      if (content !== null) {
        rovingEditorRef.current.mount(id, remountBaseline(id, content))
      }
      return result
    },
    [dedent, focusedBlockId, handleFlush, remountBaseline, t],
  )

  const handleMoveUpById = useCallback(
    (id: string) => {
      const content = id === focusedBlockId ? (rovingEditorRef.current.getMarkdown?.() ?? '') : null
      handleFlush()
      const result = announceMoveResult(
        moveUp(id).catch((err: unknown) => {
          logger.warn('useBlockActionOrchestration', 'moveUp by id failed', { blockId: id }, err)
          throw err instanceof Error ? err : new Error(String(err))
        }),
        t,
        'announce.blockMovedUp',
        () => scrollFocusedBlockIntoView(id),
      )
      if (content !== null) {
        rovingEditorRef.current.mount(id, remountBaseline(id, content))
      }
      return result
    },
    [focusedBlockId, handleFlush, moveUp, remountBaseline, t],
  )

  const handleMoveDownById = useCallback(
    (id: string) => {
      const content = id === focusedBlockId ? (rovingEditorRef.current.getMarkdown?.() ?? '') : null
      handleFlush()
      const result = announceMoveResult(
        moveDown(id).catch((err: unknown) => {
          logger.warn('useBlockActionOrchestration', 'moveDown by id failed', { blockId: id }, err)
          throw err instanceof Error ? err : new Error(String(err))
        }),
        t,
        'announce.blockMovedDown',
        () => scrollFocusedBlockIntoView(id),
      )
      if (content !== null) {
        rovingEditorRef.current.mount(id, remountBaseline(id, content))
      }
      return result
    },
    [focusedBlockId, handleFlush, moveDown, remountBaseline, t],
  )

  /**
   * Shared merge orchestration: edit `prevBlockId` with the merged content,
   * remove `removeBlockId`, and revert the edit on remove failure. The
   * caller supplies the per-handler log messages, log metadata blockIds,
   * and editor-remount cleanup callbacks so the two handlers preserve
   * their original log lines (`(edit step)` vs. `by ID (edit step)` etc.)
   * while sharing the revert + toast error path.
   *
   * Returns `true` on success, `false` if edit or remove failed (in which
   * case cleanup ran and the merge toast was shown).
   */
  const mergeBlocksAndHandle = useCallback(
    async (params: {
      prevBlockId: string
      removeBlockId: string
      prevContent: string
      mergedContent: string
      editLogMessage: string
      editLogBlockId: string
      removeLogMessage: string
      removeLogBlockId: string
      onEditFailureCleanup: () => void
      onRemoveFailureCleanup: () => void
      /**
       * #1342 — reparent the merged-away block's children onto the merge
       * target. Runs AFTER the content edit commits but BEFORE the source
       * block is removed, so the children are no longer descendants of the
       * removed block when the backend's `delete_block` cascade fires (it
       * would otherwise soft-delete the whole subtree). A no-op when the
       * source has no children. Failures are treated like a remove failure
       * (the edit is reverted) so the merge does not commit a half-state.
       */
      reparentChildren?: () => Promise<void>
    }): Promise<boolean> => {
      // Best-effort revert of the merge edit after a reparent/remove failure.
      // The store's edit resolves `false` on failure (it never rejects and
      // toasts its own save error), so honor both failure signals here.
      const revertEdit = async (): Promise<void> => {
        let reverted = false
        try {
          reverted = await edit(params.prevBlockId, params.prevContent)
        } catch (revertErr) {
          logger.warn(
            'useBlockActionOrchestration',
            'Failed to revert edit after merge failure',
            {
              blockId: params.prevBlockId,
            },
            revertErr,
          )
          return
        }
        if (!reverted) {
          logger.warn('useBlockActionOrchestration', 'Failed to revert edit after merge failure', {
            blockId: params.prevBlockId,
          })
        }
      }
      try {
        // Store contract (#730 family): pageStore.edit RESOLVES `false` on
        // failure (it rolls its optimistic write back and toasts internally)
        // — it NEVER rejects. The boolean is the production failure signal;
        // ignoring it let a failed merge-edit fall through to remove() and
        // permanently delete the source block whose merged content was never
        // saved. Route a false resolution into the shared failure path.
        if (!(await edit(params.prevBlockId, params.mergedContent))) {
          throw new Error('edit resolved false (store rolled the merge edit back)')
        }
      } catch (err) {
        logger.error(
          'useBlockActionOrchestration',
          params.editLogMessage,
          {
            blockId: params.editLogBlockId,
          },
          err,
        )
        params.onEditFailureCleanup()
        notify.error(t('blockTree.mergeBlocksFailed'))
        return false
      }
      // #1342 — reparent the source block's children onto the merge target
      // BEFORE removing the source, so the backend's delete cascade does not
      // soft-delete the subtree. Treated as a remove-step failure on error:
      // the edit is reverted and the merge does not commit a partial state.
      if (params.reparentChildren) {
        try {
          await params.reparentChildren()
        } catch (err) {
          logger.error(
            'useBlockActionOrchestration',
            params.removeLogMessage,
            {
              blockId: params.removeLogBlockId,
            },
            err,
          )
          await revertEdit()
          params.onRemoveFailureCleanup()
          notify.error(t('blockTree.mergeBlocksFailed'))
          return false
        }
      }
      try {
        await remove(params.removeBlockId)
      } catch (err) {
        logger.error(
          'useBlockActionOrchestration',
          params.removeLogMessage,
          {
            blockId: params.removeLogBlockId,
          },
          err,
        )
        // Revert the edit to avoid partial state (merged content in prev + original in current)
        await revertEdit()
        params.onRemoveFailureCleanup()
        notify.error(t('blockTree.mergeBlocksFailed'))
        return false
      }
      return true
    },
    [edit, remove, t],
  )

  const handleMergeWithPrev = useCallback(async () => {
    if (!focusedBlockId) return
    // Re-entrancy guard: the merge unmounts the roving editor (emptying its
    // doc) and then awaits IPC, so an autorepeat/double Backspace in that
    // window would route through the Backspace-on-empty rule into
    // handleDeleteBlock and race a second remove() against the in-flight
    // merge (cascade-deleting the source subtree). Mirror deleteInProgress.
    if (mergeInProgress.current) return
    // #4552 slice 3 — Backspace at the start of a styled block strips the
    // style first; the next Backspace merges. Checked before the first-block
    // guard so the first block of the page can leave a list too.
    if (focusedListStyle() !== 'none') {
      await clearFocusedListStyle(focusedBlockId)
      return
    }
    const idx = collapsedVisible.findIndex((b) => b.id === focusedBlockId)
    if (idx <= 0) return

    const prevBlock = collapsedVisible[idx - 1] as (typeof collapsedVisible)[number]
    const prevContent = prevBlock.content ?? ''
    const prevDoc = parse(prevContent)

    // No safe textual join into a verbatim prev block (code fence / table /
    // math / divider — see endsInVerbatimBlock): persist the current block's
    // typing and just move the caret to the end of the previous block,
    // keeping both blocks intact.
    if (endsInVerbatimBlock(prevDoc)) {
      handleFlush()
      setFocused(prevBlock.id)
      rovingEditorRef.current.mount(prevBlock.id, prevContent, { cursorPlacement: 'end' })
      return
    }

    mergeInProgress.current = true
    try {
      const currentContent =
        rovingEditorRef.current.unmount() ?? collapsedVisible[idx]?.content ?? ''

      // #921 f2 — neutralize a leading block-marker so the joined-in text doesn't
      // re-parse as a list item / heading / blockquote on the previous block.
      const mergedContent = joinMergedContent(prevContent, currentContent)
      const joinPoint = pmEndOfFirstBlock(prevDoc)

      // #1342 — if the merged-away block has children, reparent them onto the
      // merge target before it is removed (otherwise the backend cascade soft-
      // deletes the whole subtree). Plan from the FULL flat tree, not the
      // collapsed/visible projection.
      const reparent = planChildReparent(blocks, focusedBlockId, prevBlock.id)

      const remount = () => rovingEditorRef.current.mount(focusedBlockId, currentContent)
      const ok = await mergeBlocksAndHandle({
        prevBlockId: prevBlock.id,
        removeBlockId: focusedBlockId,
        prevContent,
        mergedContent,
        editLogMessage: 'Failed to merge blocks (edit step)',
        editLogBlockId: prevBlock.id,
        removeLogMessage: 'Failed to merge blocks (remove step)',
        removeLogBlockId: focusedBlockId,
        onEditFailureCleanup: remount,
        onRemoveFailureCleanup: remount,
        ...(reparent && {
          reparentChildren: () => moveBlocks(reparent.childIds, prevBlock.id, reparent.newIndex),
        }),
      })
      if (!ok) return

      setFocused(prevBlock.id)
      rovingEditorRef.current.mount(prevBlock.id, mergedContent)

      // #976 f22 — capture the merge TARGET so the deferred cursor placement can
      // verify the editor is still mounted on that block when the timer fires. If
      // the user arrow-navigates before the 0ms callback runs, `handleFocusNext/
      // Prev` remounts the roving editor onto a DIFFERENT block (updating
      // `activeBlockId`), and a blind `setTextSelection` would land the caret in
      // the wrong block. Guard on `activeBlockId === targetBlockId` — the same
      // deterministic check `useEditorBlur` uses — so a stale timer is a no-op.
      const targetBlockId = prevBlock.id
      if (pendingMergeSelectionRef.current !== null) {
        window.clearTimeout(pendingMergeSelectionRef.current)
      }
      pendingMergeSelectionRef.current = window.setTimeout(() => {
        pendingMergeSelectionRef.current = null
        const editor = rovingEditorRef.current.editor
        if (editor && rovingEditorRef.current.activeBlockId === targetBlockId) {
          const pmPos = Math.min(joinPoint, editor.state.doc.content.size - 1)
          editor.commands.setTextSelection(pmPos)
        }
      }, 0)
    } finally {
      mergeInProgress.current = false
    }
  }, [
    focusedBlockId,
    collapsedVisible,
    blocks,
    moveBlocks,
    mergeBlocksAndHandle,
    setFocused,
    handleFlush,
    focusedListStyle,
    clearFocusedListStyle,
  ])

  const handleMergeById = useCallback(
    async (blockId: string) => {
      // Re-entrancy guard shared with handleMergeWithPrev (see comment there).
      if (mergeInProgress.current) return
      const idx = collapsedVisible.findIndex((b) => b.id === blockId)
      if (idx <= 0) return

      const prevBlock = collapsedVisible[idx - 1] as (typeof collapsedVisible)[number]
      const prevContent = prevBlock.content ?? ''

      // No safe textual join into a verbatim prev block (see
      // handleMergeWithPrev) — the context-menu merge is simply a no-op.
      if (endsInVerbatimBlock(parse(prevContent))) return

      mergeInProgress.current = true
      try {
        const editorContent = focusedBlockId === blockId ? rovingEditorRef.current.unmount() : null
        const currentContent = editorContent ?? collapsedVisible[idx]?.content ?? ''

        // #921 f2 — see handleMergeWithPrev: strip a leading block-marker so the
        // joined-in text stays inline instead of forming a new construct.
        const mergedContent = joinMergedContent(prevContent, currentContent)

        const remountIfNeeded = () => {
          if (editorContent !== null) {
            rovingEditorRef.current.mount(blockId, currentContent)
          }
        }

        // #1342 — reparent the merged-away block's children onto the merge
        // target before removal (see handleMergeWithPrev).
        const reparent = planChildReparent(blocks, blockId, prevBlock.id)

        const ok = await mergeBlocksAndHandle({
          prevBlockId: prevBlock.id,
          removeBlockId: blockId,
          prevContent,
          mergedContent,
          editLogMessage: 'Failed to merge blocks by ID (edit step)',
          editLogBlockId: blockId,
          removeLogMessage: 'Failed to merge blocks by ID (remove step)',
          removeLogBlockId: blockId,
          onEditFailureCleanup: remountIfNeeded,
          onRemoveFailureCleanup: remountIfNeeded,
          ...(reparent && {
            reparentChildren: () => moveBlocks(reparent.childIds, prevBlock.id, reparent.newIndex),
          }),
        })
        if (!ok) return

        setFocused(prevBlock.id)
        rovingEditorRef.current.mount(prevBlock.id, mergedContent)
      } finally {
        mergeInProgress.current = false
      }
    },
    [collapsedVisible, blocks, moveBlocks, focusedBlockId, mergeBlocksAndHandle, setFocused],
  )

  const handleEnterSave = useCallback(async () => {
    if (!focusedBlockId) return
    // An in-flight merge has unmounted the editor; splitAtCaret on the emptied
    // doc would take the legacy path and create a stray sibling under the
    // block being merged away. Drop the Enter until the merge settles.
    if (mergeInProgress.current) {
      logger.warn('useBlockActionOrchestration', 'Enter press dropped — merge still in progress', {
        blockId: focusedBlockId,
      })
      return
    }
    if (enterSaveInProgress.current) {
      logger.warn(
        'useBlockActionOrchestration',
        'Enter press dropped — previous save still in progress',
        {
          blockId: focusedBlockId,
        },
      )
      return
    }
    enterSaveInProgress.current = true
    try {
      // Capture content before flush so we can re-mount on failure
      const savedContent = rovingEditorRef.current.getMarkdown?.() ?? ''

      // #4552 slice 3 — Enter on an EMPTY styled block leaves the list (the
      // exit gesture every editor shares) instead of adding another empty
      // item; on a non-empty one the sibling created below carries the style.
      const listStyle = focusedListStyle()
      if (listStyle !== 'none' && savedContent.trim() === '') {
        await clearFocusedListStyle(focusedBlockId)
        return
      }

      // #909 — split the block at the caret. When there is text AFTER the
      // caret, keep the before-text in the current block and move the
      // after-text into the new block (Logseq/Notion/ProseMirror splitBlock).
      // When the caret is at the end (after === '') or no caret split is
      // available (range selection / no editor), fall back to the legacy
      // path: flush the whole block and create an EMPTY block below.
      const split = rovingEditorRef.current.splitAtCaret?.() ?? null
      if (split && split.after !== '') {
        rovingEditorRef.current.unmount()
        // #4729 — Enter at the START of a line leaves the source block empty
        // (`before` is ''), and that blank line is the point of the keystroke.
        // Exempt it from the focus-leave empty-block cleanup NOW, before the
        // first await: `edit()` below empties the block optimistically, and a
        // click elsewhere during its round trip moves focus off the source —
        // registering only after `createBelow` resolved would let the cleanup
        // delete the source first, and `createBelow` then finds no anchor for
        // the after-text. Withdrawn on the failure paths, which restore the
        // full unsplit content.
        const leavesSourceEmpty = split.before.trim() === ''
        if (leavesSourceEmpty) preserveEmptyBlockIds?.current.add(focusedBlockId)
        // #730 family — edit() RESOLVES false on failure (the store rolled the
        // optimistic write back and toasted); it never rejects. Abort the
        // split BEFORE creating anything, restoring the full unsplit content,
        // so a failed before-caret save can't fork the block into stale text
        // plus an orphan after-text sibling (mirrors splitBlock's #730 guard).
        if (!(await edit(focusedBlockId, split.before))) {
          if (leavesSourceEmpty) preserveEmptyBlockIds?.current.delete(focusedBlockId)
          rovingEditorRef.current.mount(focusedBlockId, savedContent)
          return
        }
        // #2786 — the direct `unmount()` above bypasses `persistUnmount`
        // (the shared cleanup every OTHER programmatic block switch routes
        // through — see EditableBlock's auto-mount effect and `handleFocus`),
        // so neither `flushDraft` nor `deleteDraft` ever ran for the
        // DEPARTED (split-source) block. Left alone, a debounced
        // `block_drafts` row from before Enter was pressed survives and a
        // later boot-time `flush_all_drafts` would replay it as a stray
        // `edit_block` op. `split.before` was just committed via `edit()`
        // above — exactly the same "content already committed, row is now
        // stale" situation `persistUnmount`'s `deletePrevDraft` cleans up
        // on its own success path — so mirror that with a plain
        // `discardDraft` (delete only). Deliberately NOT `flushDraft`: the
        // stale row may hold the FULL pre-split text, and flushing it would
        // append a SECOND `edit_block` op that clobbers the split we just
        // committed with the old, un-split content.
        discardDraft(focusedBlockId)
        const newBlockId = await createBelow(focusedBlockId, split.after)
        if (newBlockId) {
          // NOT added to justCreatedBlockIds: the new block carries real
          // content, so Escape must not auto-delete it as an empty stub. (The
          // SOURCE's #4729 exemption was registered above, before the awaits;
          // this `setFocused` is what consumes it.)
          setFocused(newBlockId)
          announce(t('announce.blockCreated'))
          await continueListStyle(newBlockId, listStyle)
        } else {
          // Backend error — restore the original (unsplit) block so the user
          // isn't left with a truncated block and no place to type.
          if (leavesSourceEmpty) preserveEmptyBlockIds?.current.delete(focusedBlockId)
          rovingEditorRef.current.mount(focusedBlockId, savedContent)
        }
        return
      }

      handleFlush()
      // #2914 — when `handleFlush` took the multi-block SPLIT path it published
      // the in-flight `splitBlock` (which ALREADY creates the trailing sibling
      // blocks) via `consumePendingSplit`. AWAIT it and focus the last block it
      // produced instead of firing a parallel `createBelow` for an empty Enter
      // block: the split's own chained createBelow calls and a concurrent
      // createBelow would otherwise compute `siblingSlot` from overlapping
      // pre-await snapshots (`splitInProgress` guards only re-entrant splits,
      // not the concurrent create). The single-block (non-split) flush returns
      // null here and falls through to the unchanged create-empty-block path.
      const pendingSplit = consumePendingSplit(focusedBlockId)
      if (pendingSplit) {
        const lastSplitId = await pendingSplit
        if (lastSplitId) {
          // The last split block carries real content (the paste's final line),
          // so — like the caret-split path — it is NOT added to
          // justCreatedBlockIds (Escape must not auto-delete it as an empty stub).
          setFocused(lastSplitId)
          announce(t('announce.blockCreated'))
        } else {
          // Split failed (splitBlock rolled back + toasted) or produced no new
          // block — re-mount the source editor so the user isn't stranded on an
          // unmounted block.
          rovingEditorRef.current.mount(focusedBlockId, savedContent)
        }
        return
      }
      const newBlockId = await createBelow(focusedBlockId)
      if (newBlockId) {
        justCreatedBlockIds.current.add(newBlockId)
        setFocused(newBlockId)
        announce(t('announce.blockCreated'))
        await continueListStyle(newBlockId, listStyle)
      } else {
        // createBelow returned null (e.g. backend error) — re-mount editor
        // so the user isn't stuck with an unmounted block.
        rovingEditorRef.current.mount(focusedBlockId, savedContent)
      }
    } finally {
      enterSaveInProgress.current = false
    }
  }, [
    focusedBlockId,
    handleFlush,
    createBelow,
    edit,
    setFocused,
    justCreatedBlockIds,
    preserveEmptyBlockIds,
    discardDraft,
    t,
    focusedListStyle,
    clearFocusedListStyle,
    continueListStyle,
  ])

  const handleEscapeCancel = useCallback(() => {
    if (!focusedBlockId) return
    // Discard any persisted draft BEFORE unmounting so the autosave
    // cleanup cannot flush stale content to the database.
    discardDraft(focusedBlockId)
    const changed = rovingEditorRef.current.unmount()
    if (changed !== null) {
      notify(t('blockTree.changesDiscarded'), { duration: 2000 })
    }
    // If the block was just created and the user made no edits (changed === null),
    // delete the empty block instead of leaving it around.
    // #4577 companion — `changed === null` alone does not mean "untouched": any commit that
    // ran while the block was mounted (the content debounce, or the
    // `flushActiveDraft()` the slash commands await) rebases the delta baseline
    // through `markCommitted`, so `unmount()` reports null for a block the user
    // filled in. Confirm against the store, the same predicate BlockTree's
    // focus-change cleanup uses.
    const storeBlock = blocks.find((b) => b.id === focusedBlockId)
    const emptyInStore = storeBlock != null && (storeBlock.content ?? '').trim() === ''
    if (justCreatedBlockIds.current.has(focusedBlockId) && changed === null && emptyInStore) {
      justCreatedBlockIds.current.delete(focusedBlockId)
      remove(focusedBlockId).catch((err: unknown) => {
        logger.warn(
          'useBlockActionOrchestration',
          'Failed to remove empty just-created block on Escape',
          { blockId: focusedBlockId },
          err,
        )
      })
    }
    setFocused(null)
  }, [focusedBlockId, blocks, setFocused, justCreatedBlockIds, remove, discardDraft, t])

  return {
    handleFocusPrev,
    handleFocusNext,
    handleDeleteBlock,
    handleIndent,
    handleDedent,
    handleMoveUp,
    handleMoveDown,
    handleIndentById,
    handleDedentById,
    handleMoveUpById,
    handleMoveDownById,
    handleMergeWithPrev,
    handleMergeById,
    handleEnterSave,
    handleEscapeCancel,
  }
}
