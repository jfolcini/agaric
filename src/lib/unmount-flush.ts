/**
 * runUnmountFlush — the shared post-`unmount()` decision chain: split →
 * checkbox → inline properties → plain edit (#3278).
 *
 * Every unmount-triggered save — DOM blur (`useEditorBlur` Step 5),
 * programmatic focus move (`persistUnmount` in EditableBlock), imperative
 * flush (`useBlockFlush`) — must classify the freshly-unmounted markdown the
 * SAME way. Before this consolidation each of the three call sites open-coded
 * its own copy of this chain: only `useBlockFlush` folded a leading checkbox
 * marker (`processCheckboxSyntax`), and it alone open-coded the split test
 * instead of calling `shouldSplitOnBlur`. A single user action (pasting a
 * GFM task marker that TaskPaste declined, then leaving the block) could
 * therefore fold into `todo_state` via one trigger and save the marker
 * verbatim via another, depending on which of the three paths happened to
 * run — see the issue for the full repro.
 *
 * The chain acts only on what the edit ADDED (#5160 D2): each branch compares
 * `changed` with `loaded`, the content the editor was mounted with (or last
 * committed, see `markCommitted`). A block loaded with several paragraphs, a
 * `key:: value` line or a leading task marker — from Source, import or paste,
 * where Rust already reads them as one block of text — keeps them after a typo
 * fix; the same shapes typed into the block are split, extracted or folded.
 * `classifyUnmountFlush` is that decision on its own, shared with the
 * debounced content commit, which must skip exactly the edits this chain
 * would not commit as a plain edit.
 *
 * This function performs the classification AND makes the actual store call
 * for the chosen branch. Callers layer their own extras on top of the
 * returned `{ kind, outcome }`:
 *
 *   - `invokeSync` — wraps the SYNCHRONOUS split/edit invocation (e.g.
 *     `flushSync` on the DOM blur path, so React flushes state before the
 *     browser tears down focus). Defaults to a plain call. Never applied to
 *     the inherently async checkbox/property branches — neither call site
 *     flushSync-wraps those today.
 *   - `onWillSplit` — fires synchronously right before `splitBlock` is
 *     invoked in the split branch, so a caller can snapshot state that must
 *     be captured before the split's side effects land (`useBlockFlush`'s
 *     #2914 `pendingSplits` handoff).
 *   - `dedupe` — replays `useEditorBlur`'s #1062 skip: when the resolved
 *     branch would be the plain-edit leaf AND `changed` is byte-identical to
 *     `dedupe.content`, the duplicate `edit()` is skipped (no second
 *     flush-seq bump, matching the original Step 3 / Step 5 dance) and
 *     `dedupe.outcome` is returned instead. Never applies to the
 *     split/checkbox/property branches — those always re-run even over
 *     identical content because their extra processing (splitting, folding,
 *     stripping) has not happened yet on an early-persisted raw copy.
 *   - `pageStore` — optional; only the checkbox branch's optimistic
 *     `todo_state` write touches it. Callers/tests that never produce
 *     checkbox-marker content may omit it.
 */

import { shouldSplitOnBlur } from '@/editor/content-delta'
import { processCheckboxSyntax } from '@/lib/block-utils'
import {
  bumpFlushSeq,
  commitCheckboxState,
  commitInlineProperties,
  type PageBlockStoreLike,
} from '@/lib/inline-property-commit'
import { type InlinePropertyLine, parseInlineProperties } from '@/lib/inline-property-parse'
import type { TodoState } from '@/lib/task-states'

export type UnmountFlushResult =
  | { kind: 'split'; outcome: Promise<boolean> | void }
  | { kind: 'checkbox'; outcome: Promise<boolean> }
  | { kind: 'property'; outcome: Promise<boolean> }
  | { kind: 'edit'; outcome: Promise<boolean> | void }

export type UnmountFlushClassification =
  | { kind: 'split' }
  | { kind: 'checkbox'; cleanContent: string; todoState: TodoState }
  | { kind: 'property'; inlineProps: InlinePropertyLine[] }
  | { kind: 'edit' }

/** The `key:: value` lines of `changed` whose key `loaded` did not already carry. */
function addedInlineProperties(loaded: string, changed: string): InlinePropertyLine[] {
  const added = parseInlineProperties(changed)
  if (added.length === 0) return added
  const loadedKeys = new Set(parseInlineProperties(loaded).map((prop) => prop.key))
  return added.filter((prop) => !loadedKeys.has(prop.key))
}

/**
 * What the flush does with `changed`, given the block was loaded as `loaded`:
 * the first branch whose shape the edit introduced, else a plain edit.
 */
export function classifyUnmountFlush(loaded: string, changed: string): UnmountFlushClassification {
  if (shouldSplitOnBlur(changed, loaded)) return { kind: 'split' }
  const { cleanContent, todoState } = processCheckboxSyntax(changed)
  if (todoState && !processCheckboxSyntax(loaded).todoState) {
    return { kind: 'checkbox', cleanContent, todoState }
  }
  const inlineProps = addedInlineProperties(loaded, changed)
  if (inlineProps.length > 0) return { kind: 'property', inlineProps }
  return { kind: 'edit' }
}

export interface UnmountFlushDeps {
  blockId: string
  /** The content the editor was mounted with, or last committed
   *  (`RovingEditorHandle.originalMarkdown`, read BEFORE `unmount()` resets it). */
  loaded: string
  /** Non-null unmounted content — callers only invoke this after checking
   *  `unmount()` did not return null. */
  changed: string
  edit: (blockId: string, content: string) => Promise<boolean> | void
  splitBlock: (blockId: string, content: string) => Promise<boolean> | void
  rootParentId: string | null
  /** Optional; required only for the checkbox branch's optimistic write. */
  pageStore?: PageBlockStoreLike | undefined
  /** Wraps the split/edit branches' synchronous store call. Default: plain call. */
  invokeSync?: <T>(fn: () => T) => T
  /** Fires right before `splitBlock` is invoked in the split branch. */
  onWillSplit?: () => void
  /** #1062 dedup: skip the plain-edit leaf when `changed` matches. */
  dedupe?: { content: string; outcome: Promise<boolean> | void } | undefined
}

export function runUnmountFlush(deps: UnmountFlushDeps): UnmountFlushResult {
  const {
    blockId,
    loaded,
    changed,
    edit,
    splitBlock,
    rootParentId,
    pageStore,
    invokeSync = (fn) => fn(),
    onWillSplit,
    dedupe,
  } = deps

  const classified = classifyUnmountFlush(loaded, changed)

  // 1. Split — blocks the edit added always win; a marker or property line
  //    embedded in one of several resulting blocks is folded the next time
  //    THAT block is individually flushed, not here.
  if (classified.kind === 'split') {
    bumpFlushSeq(blockId)
    onWillSplit?.()
    const outcome = invokeSync(() => splitBlock(blockId, changed))
    return { kind: 'split', outcome }
  }

  // 2. Checkbox — a leading GFM task marker the edit typed folds into `todo_state`.
  if (classified.kind === 'checkbox') {
    const mySeq = bumpFlushSeq(blockId)
    const outcome = commitCheckboxState({
      blockId,
      content: changed,
      cleanContent: classified.cleanContent,
      todoState: classified.todoState,
      mySeq,
      edit,
      pageStore,
      rootParentId,
    })
    return { kind: 'checkbox', outcome }
  }

  // 3. Inline `key:: value` properties the edit added.
  if (classified.kind === 'property') {
    const mySeq = bumpFlushSeq(blockId)
    const outcome = commitInlineProperties({
      blockId,
      content: changed,
      inlineProps: classified.inlineProps,
      mySeq,
      edit,
      rootParentId,
    })
    return { kind: 'property', outcome }
  }

  // 4. Plain edit — with the #1062 dedup skip.
  if (dedupe && dedupe.content === changed) {
    return { kind: 'edit', outcome: dedupe.outcome }
  }
  bumpFlushSeq(blockId)
  const outcome = invokeSync(() => edit(blockId, changed))
  return { kind: 'edit', outcome }
}
