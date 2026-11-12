import type { TFunction } from 'i18next'
import type { RefObject } from 'react'
import { useCallback, useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'

import { consumePendingSplit } from '@/components/block-tree/use-block-flush'
import { textPointAtLine } from '@/editor/click-caret'
import { shouldSplitOnBlur } from '@/editor/content-delta'
import { parse } from '@/editor/markdown-serializer'
import type { DocNode } from '@/editor/types'
import { pmEndOfFirstBlock } from '@/editor/types'
import type { DeleteBlockOpts } from '@/editor/use-block-keyboard'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { announce } from '@/lib/announcer'
import { newBlockId } from '@/lib/block-id'
import type { ListStyle } from '@/lib/list-style'
import { clearListStyle, setListStyle } from '@/lib/list-style'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import type { FlatBlock } from '@/lib/tree-utils'
import type { MountedBlocks } from '@/lib/zoom-scope'
import { useBlockStore } from '@/stores/blocks'
import type { usePageBlockStoreApi } from '@/stores/page-blocks'
import type { DeleteBlockOptions } from '@/stores/page-blocks-types'
import { classifyUnmountFlush } from '@/stores/unmount-flush'

/**
 * A text holding nothing typed, in as many top-level blocks as `markdown`.
 * Against it the leave-time flush commits the task marker, `key:: value` lines
 * and `#name`s `markdown` holds, and finds no block added, so its paragraphs
 * stay one block.
 */
function untypedBaseline(markdown: string): string {
  const blocks = parse(markdown).content?.length ?? 1
  return Array.from({ length: blocks }, () => '.').join('\n\n')
}

/**
 * Read the block Enter split off, holding `split.after`, as typed, as page mode
 * reads a new block: the task marker, `key:: value` lines or `#name` it holds
 * are committed when the caret leaves it, and its paragraphs stay one block, as
 * page mode keeps them. Plain text keeps the stored baseline, so leaving writes
 * nothing. So does the whole block moved by Enter at its start: page mode keeps
 * that text in the block it was loaded in.
 */
function readSplitOffAsTyped(
  editor: Pick<RovingEditorHandle, 'activeBlockId' | 'readAsTyped'>,
  blockId: string,
  split: { before: string; after: string },
): void {
  if (split.before.trim() === '') return
  const untyped = untypedBaseline(split.after)
  if (classifyUnmountFlush(untyped, split.after).kind === 'edit') return
  if (editor.activeBlockId === blockId) editor.readAsTyped(untyped)
}

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

/** The focused editor's markdown and the content it was mounted with. */
interface EditorCapture {
  content: string
  loaded: string
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
    | 'originalMarkdown'
    | 'splitAtCaret'
    | 'storedMarkdown'
    | 'readAsTyped'
  >
  setFocused: (id: string | null) => void
  /** Replace the block selection; a non-empty one also leaves editing. */
  setSelected: (ids: string[]) => void
  handleFlush: () => string | null
  /**
   * #4957 — page store API, read for the post-flush remount baseline (see
   * {@link useBlockActionOrchestration}'s `remountBaseline`).
   */
  pageStore: ReturnType<typeof usePageBlockStoreApi>
  remove: (id: string, options?: DeleteBlockOptions) => Promise<void>
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
  createBelow: (afterBlockId: string, content: string, blockId: string) => Promise<string | null>
  /**
   * #4729 — ids BlockTree's leaked-empty-block cleanup must skip exactly once.
   *
   * Enter pressed at the START of a block splits it into `before = ''` and
   * `after = <the whole line>`: the source block keeps its slot and is left
   * deliberately EMPTY, the text moves into a new sibling below, and focus
   * follows the text. That empty source is the user's blank line, so the
   * focus-leave cleanup must not treat it as a leak — otherwise Enter-at-line-
   * start becomes a visible no-op. Registered here before focus moves to the
   * new sibling, consumed (and cleared) by the cleanup effect on that focus
   * change, and withdrawn on the split's failure paths, which restore the
   * source's full content.
   *
   * Optional: callers that never drive a caret split (isolated hook tests) may
   * omit it.
   */
  preserveEmptyBlockIds?: RefObject<Set<string>>
  /**
   * Discard any persisted draft for the given block. Called by Discard, and
   * (#2786) after a successful caret-split `edit()` to drop the departed
   * block's now-stale pre-split draft row.
   */
  discardDraft: (blockId: string) => void
  t: TFunction
}

export interface UseBlockActionOrchestrationReturn {
  handleFocusPrev: (caretX?: number) => void
  handleFocusNext: (caretX?: number) => void
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
  handleEscapeSave: () => void
}

export function useBlockActionOrchestration({
  focusedBlockId,
  collapsedVisible,
  blocks,
  revealNextMounted,
  rovingEditor,
  setFocused,
  setSelected,
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
  preserveEmptyBlockIds,
  discardDraft,
  t,
}: UseBlockActionOrchestrationParams): UseBlockActionOrchestrationReturn {
  const rovingEditorRef = useRef(rovingEditor)
  // The by-id handlers sit in every row's `BlockActions` context; reading focus
  // at call time keeps a focus move from re-rendering every row.
  const focusedBlockIdRef = useRef(focusedBlockId)
  useLayoutEffect(() => {
    rovingEditorRef.current = rovingEditor
    focusedBlockIdRef.current = focusedBlockId
  })

  // Re-entrancy guard: prevents rapid Backspace presses from duplicating deletes.
  const deleteInProgress = useRef(false)

  // The latest Enter in flight. A restructure chord waits for it
  // (`afterEnterSettles`).
  const enterInFlight = useRef<Promise<void> | null>(null)

  // Re-entrancy guard for merges, whose edit, reparent and remove are in flight
  // until the merge settles. handleMergeById unmounts the roving editor
  // (resetting its doc to empty) meanwhile, so an autorepeat Backspace matches
  // the Backspace-on-empty rule and an Enter the create rule, both on the block
  // being merged away; after a Backspace merge an Enter would send a second
  // edit of the joined block, which can land before the merge's.
  // handleDeleteBlock/handleEnterSave honor this flag so no concurrent
  // structural op races the merge.
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
  // any inheritance from a parent. `handleEnterSave` records the optimistic
  // style when it focuses the sibling, before the create and this write: the
  // gesture it exists for is a second Enter, which lands while they are in
  // flight. Dropped on failure so a rejected write cannot leave the keyboard
  // grain acting on a list the block never joined.
  const continueListStyle = useCallback(
    async (blockId: string, style: ListStyle): Promise<void> => {
      if (style === 'none') return
      try {
        await setListStyle(blockId, style)
      } catch (err) {
        if (optimisticListStyle.current?.blockId === blockId) {
          optimisticListStyle.current = null
        }
        logger.error(
          'useBlockActionOrchestration',
          'setListStyle (Enter continuation) failed',
          { blockId, style },
          err,
        )
        notify.error(t('blockTree.setListStyleFailed'))
      }
    },
    [t],
  )

  // Step onto `block`; with `caretX`, an Arrow Up / Down, the caret lands on
  // its `line` at that x, read from its static render before the mount (#6537).
  const focusNeighbour = useCallback(
    (block: FlatBlock, caretX: number | undefined, line: 'first' | 'last') => {
      const content = block.content ?? ''
      const render =
        caretX === undefined
          ? null
          : document.querySelector(`[data-testid="block-static"][data-block-id="${block.id}"]`)
      const caret =
        caretX === undefined || render === null
          ? null
          : textPointAtLine(render, content, caretX, line)
      setFocused(block.id)
      if (caret === null) rovingEditorRef.current.mount(block.id, content)
      else rovingEditorRef.current.mount(block.id, content, { cursorPlacement: caret })
      announce(
        t('announce.editingBlock', { preview: content.slice(0, 50) || t('announce.emptyBlock') }),
      )
    },
    [setFocused, t],
  )

  const handleFocusPrev = useCallback(
    (caretX?: number) => {
      const idx = collapsedVisible.findIndex((b) => b.id === focusedBlockId)
      if (idx > 0) {
        const prevBlock = collapsedVisible[idx - 1] as (typeof collapsedVisible)[number]
        focusNeighbour(prevBlock, caretX, 'last')
      }
    },
    [collapsedVisible, focusedBlockId, focusNeighbour],
  )

  const handleFocusNext = useCallback(
    (caretX?: number) => {
      const idx = collapsedVisible.findIndex((b) => b.id === focusedBlockId)
      if (idx < 0) return
      // #4959 — at the last MOUNTED row, reveal the row past the mount cap and
      // step onto it; the reveal and the focus batch into one render, so the row
      // mounts already focused.
      const nextBlock: FlatBlock | null | undefined =
        idx < collapsedVisible.length - 1 ? collapsedVisible[idx + 1] : revealNextMounted?.()
      if (!nextBlock) return
      focusNeighbour(nextBlock, caretX, 'first')
    },
    [collapsedVisible, focusedBlockId, revealNextMounted, focusNeighbour],
  )

  const handleDeleteBlock = useCallback(
    (opts?: DeleteBlockOpts) => {
      if (!focusedBlockId) return
      if (deleteInProgress.current) return
      // A merge in flight (see `mergeInProgress`): bail instead of racing a
      // second remove() against its own.
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
        // the merge handlers' `idx <= 0` bail. Say so — a Backspace that
        // silently does nothing reads as a broken key.
        notify.error(t('blockTree.cannotDeleteParentAtTop'))
        announce(t('blockTree.cannotDeleteParentAtTop'))
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
   * What the focused editor holds right before a flush: its markdown, and the
   * content it was mounted with, which the flush's split decision compares it
   * against (#5160 D2) and `unmount()` resets.
   */
  const captureEditor = useCallback(
    (): EditorCapture => ({
      content: rovingEditorRef.current.getMarkdown?.() ?? '',
      loaded: rovingEditorRef.current.originalMarkdown,
    }),
    [],
  )

  /**
   * #4957 — what the restructure handlers remount with after `handleFlush()`.
   * A capture that added blocks was split: `splitBlock` wrote line 1 into the
   * store synchronously, so remounting the full capture would re-commit lines
   * 2..N that now exist as siblings. The `?? content` covers a block another
   * page's store owns (#4550 embeds), which the flush leaves unsplit.
   */
  const remountBaseline = useCallback(
    (blockId: string, { content, loaded }: EditorCapture): string =>
      shouldSplitOnBlur(content, loaded)
        ? (pageStore.getState().blocksById.get(blockId)?.content ?? content)
        : content,
    [pageStore],
  )

  const handleIndentById = useCallback(
    (id: string) => {
      const content = id === focusedBlockIdRef.current ? captureEditor() : null
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
    [captureEditor, handleFlush, indent, remountBaseline, t],
  )

  const handleDedentById = useCallback(
    (id: string) => {
      const content = id === focusedBlockIdRef.current ? captureEditor() : null
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
    [captureEditor, dedent, handleFlush, remountBaseline, t],
  )

  const handleMoveUpById = useCallback(
    (id: string) => {
      const content = id === focusedBlockIdRef.current ? captureEditor() : null
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
    [captureEditor, handleFlush, moveUp, remountBaseline, t],
  )

  const handleMoveDownById = useCallback(
    (id: string) => {
      const content = id === focusedBlockIdRef.current ? captureEditor() : null
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
    [captureEditor, handleFlush, moveDown, remountBaseline, t],
  )

  // Until Enter's create lands the backend does not have the block it focused,
  // and a move of it would be refused. Run a chord pressed in that window (Tab,
  // a move) on the block focused once Enter settles.
  const afterEnterSettles = useCallback((chord: (id: string) => Promise<void>): boolean => {
    const enter = enterInFlight.current
    if (!enter) return false
    void enter.then(() => {
      const id = useBlockStore.getState().focusedBlockId
      if (id) void chord(id)
    })
    return true
  }, [])

  const handleIndent = useCallback(() => {
    if (afterEnterSettles(handleIndentById)) return
    if (!focusedBlockId) return
    const blockId = focusedBlockId
    const content = captureEditor()
    handleFlush()
    // R6 (#405): announce on RESOLUTION so assistive tech reports the real
    // outcome — a no-op (already at outermost level) or a backend rejection
    // must not announce a phantom "indented".
    void announceMoveResult(indent(blockId), t, 'announce.blockIndented')
    rovingEditorRef.current.mount(blockId, remountBaseline(blockId, content))
  }, [
    afterEnterSettles,
    captureEditor,
    focusedBlockId,
    handleFlush,
    handleIndentById,
    indent,
    remountBaseline,
    t,
  ])

  const handleDedent = useCallback(() => {
    if (afterEnterSettles(handleDedentById)) return
    if (!focusedBlockId) return
    const blockId = focusedBlockId
    const content = captureEditor()
    handleFlush()
    void announceMoveResult(dedent(blockId), t, 'announce.blockDedented')
    rovingEditorRef.current.mount(blockId, remountBaseline(blockId, content))
  }, [
    afterEnterSettles,
    captureEditor,
    focusedBlockId,
    handleFlush,
    handleDedentById,
    dedent,
    remountBaseline,
    t,
  ])

  const handleMoveUp = useCallback(() => {
    if (afterEnterSettles(handleMoveUpById)) return
    if (!focusedBlockId) return
    const content = captureEditor()
    handleFlush()
    const blockId = focusedBlockId
    // R6 (#405): announce + scroll on RESOLUTION — a boundary no-op or backend
    // rejection must not announce a phantom "moved up".
    void announceMoveResult(moveUp(blockId), t, 'announce.blockMovedUp', () =>
      scrollFocusedBlockIntoView(blockId),
    )
    rovingEditorRef.current.mount(blockId, remountBaseline(blockId, content))
  }, [
    afterEnterSettles,
    captureEditor,
    focusedBlockId,
    handleFlush,
    handleMoveUpById,
    moveUp,
    remountBaseline,
    t,
  ])

  const handleMoveDown = useCallback(() => {
    if (afterEnterSettles(handleMoveDownById)) return
    if (!focusedBlockId) return
    const content = captureEditor()
    handleFlush()
    const blockId = focusedBlockId
    void announceMoveResult(moveDown(blockId), t, 'announce.blockMovedDown', () =>
      scrollFocusedBlockIntoView(blockId),
    )
    rovingEditorRef.current.mount(blockId, remountBaseline(blockId, content))
  }, [
    afterEnterSettles,
    captureEditor,
    focusedBlockId,
    handleFlush,
    handleMoveDownById,
    moveDown,
    remountBaseline,
    t,
  ])

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
    // Re-entrancy guard (see `mergeInProgress`): a second merge would race
    // the first's remove() (cascade-deleting the source subtree).
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

      // The merge failed: the user gets the block they merged away back with
      // its text. What they typed at the join has nowhere to go.
      const backToSource = () => {
        rovingEditorRef.current.unmount()
        rovingEditorRef.current.mount(focusedBlockId, currentContent)
        setFocused(focusedBlockId)
      }
      const merged = mergeBlocksAndHandle({
        prevBlockId: prevBlock.id,
        removeBlockId: focusedBlockId,
        prevContent,
        mergedContent,
        editLogMessage: 'Failed to merge blocks (edit step)',
        editLogBlockId: prevBlock.id,
        removeLogMessage: 'Failed to merge blocks (remove step)',
        removeLogBlockId: focusedBlockId,
        onEditFailureCleanup: backToSource,
        onRemoveFailureCleanup: backToSource,
        ...(reparent && {
          reparentChildren: () => moveBlocks(reparent.childIds, prevBlock.id, reparent.newIndex),
        }),
      })

      // #6559 — the caret goes to the join now, not once the writes land, so
      // keys typed meanwhile go there.
      rovingEditorRef.current.mount(prevBlock.id, mergedContent)
      flushSync(() => setFocused(prevBlock.id))
      const editor = rovingEditorRef.current.editor
      if (editor) {
        editor.commands.setTextSelection(Math.min(joinPoint, editor.state.doc.content.size - 1))
        // As Enter's `focusCreated`: the commit dropped the editor's focus.
        editor.view.focus()
      }
      await merged
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
        const editorContent =
          focusedBlockIdRef.current === blockId ? rovingEditorRef.current.unmount() : null
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
    [collapsedVisible, blocks, moveBlocks, mergeBlocksAndHandle, setFocused],
  )

  const handleEnterSave = useCallback(async () => {
    if (!focusedBlockId) return
    if (mergeInProgress.current) {
      logger.warn('useBlockActionOrchestration', 'Enter press dropped — merge still in progress', {
        blockId: focusedBlockId,
      })
      return
    }
    // Until the Enter in flight mounts the block it creates, the editor holds
    // nothing, and splitting it would add a stray empty sibling. Only the #2914
    // split below leaves that window: it focuses once its creates land.
    if (enterInFlight.current && rovingEditorRef.current.activeBlockId === null) {
      logger.warn('useBlockActionOrchestration', 'Enter press dropped — block split in progress', {
        blockId: focusedBlockId,
      })
      return
    }
    let settle: () => void = () => undefined
    const enter = new Promise<void>((resolve) => {
      settle = resolve
    })
    enterInFlight.current = enter
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

      // #6559 — the new block is in the store as soon as `createBelow` is
      // called, so focus moves to it then, not once the IPC answers: keys typed
      // meanwhile land in it. The store holds a write to it until it exists.
      const createdId = newBlockId()
      const focusCreated = () => {
        flushSync(() => setFocused(createdId))
        // The commit moved the editor into the new row, which drops its focus
        // until `mount()`'s next-frame refocus: a key typed sooner hits the page.
        rovingEditorRef.current.editor?.view.focus()
        if (listStyle !== 'none')
          optimisticListStyle.current = { blockId: createdId, style: listStyle }
      }
      // The create failed: the user gets the block Enter left back with its
      // full text, unless they have moved on. What they typed into the new
      // block has nowhere to go.
      const restoreSource = () => {
        if (useBlockStore.getState().focusedBlockId !== createdId) return
        rovingEditorRef.current.unmount()
        flushSync(() => setFocused(focusedBlockId))
        rovingEditorRef.current.mount(focusedBlockId, savedContent)
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
        // Exempt it from the focus-leave empty-block cleanup before focus
        // leaves it. Withdrawn on the failure paths, which restore the full
        // unsplit content.
        const leavesSourceEmpty = split.before.trim() === ''
        if (leavesSourceEmpty) preserveEmptyBlockIds?.current.add(focusedBlockId)
        // #5272 — create the after-text sibling BEFORE shortening the source.
        // A `[[link]]` whose target lives in another space is accepted only
        // while a live block of this page still holds it; saving `before`
        // first removed the only holder of a link sitting after the caret,
        // and the create was refused.
        const created = createBelow(focusedBlockId, split.after, createdId)
        focusCreated()
        readSplitOffAsTyped(rovingEditorRef.current, createdId, split)
        if (!(await created)) {
          // createBelow logged + toasted and nothing was written.
          if (leavesSourceEmpty) preserveEmptyBlockIds?.current.delete(focusedBlockId)
          restoreSource()
          return
        }
        // #730 family — edit() RESOLVES false on failure (the store rolled the
        // optimistic write back and toasted); it never rejects. The source
        // then still holds the after-text, so delete the sibling just created
        // instead of leaving that text duplicated below the restored source.
        if (!(await edit(focusedBlockId, split.before))) {
          try {
            await remove(createdId)
          } catch (err) {
            // BlockTree's `remove` throws when the block is still in the store
            // after a failed delete (the store toasted). The after-text is then
            // held by both blocks, converged with the backend; the user still
            // needs their editor back.
            logger.warn(
              'useBlockActionOrchestration',
              'Split rollback left the after-text sibling behind',
              { blockId: focusedBlockId, newBlockId: createdId },
              err,
            )
          }
          if (leavesSourceEmpty) preserveEmptyBlockIds?.current.delete(focusedBlockId)
          restoreSource()
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
        announce(t('announce.blockCreated'))
        await continueListStyle(createdId, listStyle)
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
      const created = createBelow(focusedBlockId, '', createdId)
      focusCreated()
      if (!(await created)) {
        restoreSource()
        return
      }
      announce(t('announce.blockCreated'))
      await continueListStyle(createdId, listStyle)
    } finally {
      if (enterInFlight.current === enter) enterInFlight.current = null
      settle()
    }
  }, [
    focusedBlockId,
    handleFlush,
    createBelow,
    edit,
    remove,
    setFocused,
    preserveEmptyBlockIds,
    discardDraft,
    t,
    focusedListStyle,
    clearFocusedListStyle,
    continueListStyle,
  ])

  // #5160 D17 — Escape keeps the text: the same flush every other way out of a
  // block takes, then the block is selected so the block-selection keys act on
  // it. A blank block is left unselected, because leaving it lets BlockTree's
  // empty-block cleanup delete it and the selection would outlive the block.
  const handleEscapeSave = useCallback(() => {
    if (!focusedBlockId) return
    const blank = captureEditor().content.trim() === ''
    handleFlush()
    if (blank) setFocused(null)
    else setSelected([focusedBlockId])
  }, [focusedBlockId, captureEditor, handleFlush, setFocused, setSelected])

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
    handleEscapeSave,
  }
}
