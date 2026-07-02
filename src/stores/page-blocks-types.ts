/**
 * Shared types for the per-page block store.
 *
 * Extracted from `page-blocks.ts` (#2254) so the store core, the reducers
 * module (`page-blocks-reducers.ts`) and the optimistic structural-move core
 * (`page-blocks-move.ts`) can all reference `PageBlockState` without a circular
 * import (core imports the reducers; the reducers reference the state type).
 */

import type { BlockRow } from '../lib/tauri'
import type { FlatBlock } from '../lib/tree-utils'

export type { FlatBlock }

export interface PageBlockState {
  /** Ordered flat-tree of blocks for this page (depth-annotated). */
  blocks: FlatBlock[]
  /**
   * O(1) lookup index over `blocks`, keyed by block id (G).
   * Always rebuilt from `blocks` on every mutation that touches the array;
   * the array is the source of truth for ordering, the Map is a derived cache.
   * Mutations produce a new Map reference so Zustand selector subscribers fire.
   */
  blocksById: Map<string, FlatBlock>
  /** The root parent ID for this page. */
  rootParentId: string | null
  /** Loading state. */
  loading: boolean

  /**
   * #1258 — total active descendant count when the backend truncated the
   * page at its `PAGE_SUBTREE_MAX_BLOCKS` safety cap; `null` when the full
   * page was returned. `blocks.length` is the truncated (capped) count, so
   * the UI can show "showing the first {blocks.length} of {truncatedTotal}".
   * The backend orders the cap by a flat (position, id) key, so a deeply
   * nested child whose parent row was cut is dropped from `blocks` by
   * `buildFlatTree`; this signal is the only honest indication of that loss.
   */
  truncatedTotal: number | null

  /** O(1) helper — `state.blocksById.get(id)`. */
  getBlockById: (id: string) => FlatBlock | undefined

  /** Load the full block subtree from the backend. */
  load: () => Promise<void>

  /** Create a new block below the given block. Returns the new block ID. */
  createBelow: (afterBlockId: string, content?: string) => Promise<string | null>
  /** Edit a block's content. Resolves `true` on success, `false` if the
   * write failed (the optimistic update is rolled back and a generic
   * save-failed toast is shown). Callers that need a context-specific error
   * (e.g. the query builder) can branch on the returned boolean. */
  edit: (blockId: string, content: string) => Promise<boolean>
  /** Delete a block (and its descendants from the flat tree). */
  remove: (blockId: string) => Promise<void>

  /**
   * Auto-split: given a block ID and markdown with newlines, split into
   * multiple blocks. First line edits the original, subsequent lines
   * create new blocks below.
   */
  splitBlock: (blockId: string, markdown: string) => Promise<void>

  /**
   * Reorder: move block to a 0-based sibling slot (#400). `newIndex` is an
   * insertion slot among the block's same-parent siblings (0 = first / top).
   * Applies an optimistic local splice — no `load()` (R5 / #404).
   */
  reorder: (blockId: string, newIndex: number) => Promise<void>

  /**
   * Move block under a new parent at a 0-based sibling slot (#400). Structural,
   * so it reloads the tree (`load()`).
   */
  moveToParent: (blockId: string, newParentId: string | null, newIndex: number) => Promise<void>

  /**
   * #914 — multi-select drag. Move a set of blocks (`ids`, in document order)
   * under `newParentId`, landing contiguously starting at the 0-based sibling
   * slot `newIndex`, preserving their relative order. Structural (it issues one
   * `move_block` IPC per block and then reloads the tree), atomic from the
   * user's view: a single drag gesture relocates the whole selection.
   *
   * Callers pass the SELECTION ROOTS only (see `computeSelectionRoots`) — a
   * block already nested inside another moved block must NOT be listed; it
   * travels inside its ancestor's subtree.
   */
  moveBlocks: (ids: string[], newParentId: string | null, newIndex: number) => Promise<void>

  /**
   * Indent: make block a child of its previous sibling (same depth).
   * Resolves `true` when the move committed, `false` on a no-op or a caught
   * backend error (which also toasts) — so callers can announce accurately.
   */
  indent: (blockId: string) => Promise<boolean>
  /** Dedent: move block up one level to grandparent. Returns success (see `indent`). */
  dedent: (blockId: string) => Promise<boolean>

  /** Move block up among its siblings. Returns success (see `indent`). */
  moveUp: (blockId: string) => Promise<boolean>
  /** Move block down among its siblings. Returns success (see `indent`). */
  moveDown: (blockId: string) => Promise<boolean>

  /**
   * #913 — paste an indented-markdown outline as a real block subtree after
   * the `anchorBlockId`. The parsed top-level blocks land as SIBLINGS of the
   * anchor (right after it), with nested lines materialized as descendants,
   * preserving the outline's structure.
   *
   * If `markdown` parses to nothing recognizable (empty / whitespace-only), a
   * single content block is created from the raw text instead of throwing —
   * paste should never be a silent no-op when the clipboard held text. Routes
   * through `createBlocksBatch` (one IPC per depth level, like
   * `insertTemplateBlocks`) and then reloads the tree. Resolves the ids of all
   * created blocks (empty array on failure or when the anchor vanished).
   */
  pasteBlocks: (anchorBlockId: string, markdown: string) => Promise<string[]>

  /**
   * Append a single backend-returned `BlockRow` to the
   * in-memory flat tree at depth 0 (top-level child of this page).
   *
   * Used by callers that already have the freshly-created row in hand and
   * would otherwise re-fetch the entire page just to surface it. Pure FE
   * splice — no IPC, no undo notification (the calling create path owns
   * both side effects).
   */
  appendBlock: (row: BlockRow) => void
}
