/**
 * Types for the per-page block store, apart so the core, the reducers and the
 * move core can share `PageBlockState` without an import cycle.
 */

import type { BlockRow, PageSourceReport, PasteInput, PasteSplice } from '@/lib/bindings'
import type { FlatBlock } from '@/lib/tree-utils'

export type { FlatBlock }

/**
 * Options for `PageBlockState.remove`. `undoable: false` marks housekeeping
 * the user did not ask for (the leaked-empty-block cleanup, #4729): the delete
 * still appends its op, syncs and lands in Trash, but the undo store is not
 * told, so it neither takes the next Ctrl+Z nor drops a pending Ctrl+Y. Trash
 * is its recovery. Every user-initiated delete keeps the default.
 */
export interface DeleteBlockOptions {
  /** Default `true`; `false` is housekeeping. */
  undoable?: boolean
}

export interface PageBlockState {
  /** Ordered flat-tree of blocks for this page (depth-annotated). */
  blocks: FlatBlock[]
  /**
   * Id index over `blocks`, which stays the truth for order. Every write that
   * changes the array writes a new Map, so selector subscribers fire.
   */
  blocksById: Map<string, FlatBlock>
  /** The root parent ID for this page. */
  rootParentId: string | null
  loading: boolean
  /**
   * Loads that brought a snapshot in (failed or superseded ones do not count).
   * A reload keeps rows mounted (#6533), so what the tree reads beside the
   * blocks, their properties, is re-read when this moves.
   */
  completedLoads: number

  /**
   * The true descendant count when the backend truncated the page at
   * `PAGE_SUBTREE_MAX_BLOCKS`, else `null` (#1258). The cap orders by a flat
   * (position, id) key, so a child whose parent row was cut is dropped from
   * `blocks`; this is the only honest signal of that loss.
   */
  truncatedTotal: number | null

  /**
   * The focused block a reload kept at its pre-reload text, because the fresh
   * text differed while its editor held uncommitted text (#5278, #6533), with
   * the text kept. Leaving it without typing reloads it.
   */
  staleFocusedBlock: { id: string; content: FlatBlock['content'] } | null

  /** `state.blocksById.get(id)`. */
  getBlockById: (id: string) => FlatBlock | undefined

  /** Load the full block subtree from the backend. */
  load: () => Promise<void>

  /**
   * Create a block below `afterBlockId`; resolves its id, or `null` on failure.
   * The row is in the store when the call returns, so a caller that passes
   * `blockId` can focus it before the create answers.
   */
  createBelow: (afterBlockId: string, content?: string, blockId?: string) => Promise<string | null>
  /**
   * Edit a block's content; `false` when the write failed (rolled back and
   * toasted), so a caller can show its own error. `merge: false` makes the edit
   * an undo entry of its own, as a paste is, instead of joining the block's
   * typing session. `undoGroup` joins the edit to the entry of earlier edits
   * with the same key, whatever block they changed (a replace-all); with
   * `merge: false` it starts that entry.
   */
  edit: (
    blockId: string,
    content: string,
    options?: { merge?: boolean; undoGroup?: string },
  ) => Promise<boolean>
  /** Delete a block and its subtree; `options` default to a user-initiated delete. */
  remove: (blockId: string, options?: DeleteBlockOptions) => Promise<void>

  /**
   * Split `markdown` with newlines into blocks: the first line edits the
   * original, the rest are created below. `true` only when the plan fully
   * committed (a noop included), so the blur path can gate its draft discard.
   */
  splitBlock: (blockId: string, markdown: string) => Promise<boolean>

  /**
   * Move a block to sibling slot `newIndex` (0 = first) under the same parent,
   * splicing locally without a `load()` (#404).
   */
  reorder: (blockId: string, newIndex: number) => Promise<void>

  /**
   * Move a block under a new parent at sibling slot `newIndex`, splicing
   * optimistically when the target is loaded and outside its subtree, else
   * reloading.
   */
  moveToParent: (blockId: string, newParentId: string | null, newIndex: number) => Promise<void>

  /**
   * Move the selection roots `ids` under `newParentId`, landing contiguously
   * from slot `newIndex` in their document order, in one `move_blocks_batch`
   * transaction (#914, #2274). A block nested in another moved block must not
   * be listed (`computeSelectionRoots`); it travels with its ancestor.
   */
  moveBlocks: (ids: string[], newParentId: string | null, newIndex: number) => Promise<void>

  /**
   * Make a block the last child of its previous sibling. `true` when the move
   * committed, `false` on a no-op or a failure (toasted), so callers announce
   * accurately.
   */
  indent: (blockId: string) => Promise<boolean>
  /** Move a block up one level, after its parent. Success as for `indent`. */
  dedent: (blockId: string) => Promise<boolean>

  /** Move a block up among its siblings, or out before its parent as the first child. Success as for `indent`. */
  moveUp: (blockId: string) => Promise<boolean>
  /** Move a block down among its siblings, or out after its parent as the last child. Success as for `indent`. */
  moveDown: (blockId: string) => Promise<boolean>

  /**
   * Paste clipboard text (an HTML paste's as Document text) after
   * `anchorBlockId`, as one `paste_blocks` command and one undo entry, then
   * reload (#913, #5140). Resolves the pasted content ids in document order,
   * empty when the anchor is not on this page or the command failed (toasted).
   *
   * With a `splice` the paste goes into the anchor's text: the anchor becomes
   * the first pasted block (`before` + its content) and the first id; `after`
   * ends the last one. The anchor's new text reaches the store and `onSpliced`
   * before the reload (#5160).
   */
  pasteBlocks: (
    anchorBlockId: string,
    input: PasteInput,
    splice?: PasteSplice,
    onSpliced?: (content: string) => void,
  ) => Promise<string[]>

  /**
   * Copy `blockId` and its subtree right after it, as one `duplicate_block`
   * command and one undo entry, then reload. A block not on this page is a
   * no-op; a failure toasts.
   */
  duplicateBlock: (blockId: string) => Promise<void>

  /**
   * Save the page edited as its source, as one `apply_page_source` command and
   * one undo entry, then reload (#5140). `source` is the buffer in the Document
   * dialect, `lineIds` the block id each line carries, `baseSource` the
   * `get_page_buffer` source it was loaded from; `merge` folds in what changed
   * since instead of refusing a stale base. Rejects with the backend's error
   * untouched (no toast), so the caller can tell `RequiresRefresh` from a
   * buffer it must fix.
   */
  applyPageSource: (
    source: string,
    baseSource: string,
    merge: boolean,
    lineIds: Array<string | null>,
  ) => Promise<PageSourceReport>

  /**
   * Append a backend-returned row at depth 0 without re-fetching the page. No
   * IPC and no undo notification: the calling create path owns both.
   */
  appendBlock: (row: BlockRow) => void
}
