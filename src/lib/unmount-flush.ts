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
import { parseInlineProperties } from '@/lib/inline-property-parse'

export type UnmountFlushResult =
  | { kind: 'split'; outcome: Promise<boolean> | void }
  | { kind: 'checkbox'; outcome: Promise<boolean> }
  | { kind: 'property'; outcome: Promise<boolean> }
  | { kind: 'edit'; outcome: Promise<boolean> | void }

export interface UnmountFlushDeps {
  blockId: string
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
    changed,
    edit,
    splitBlock,
    rootParentId,
    pageStore,
    invokeSync = (fn) => fn(),
    onWillSplit,
    dedupe,
  } = deps

  // 1. Split — multi-block pasted/typed content always wins; a marker or
  //    property line embedded in one of several resulting blocks is folded
  //    the next time THAT block is individually flushed, not here.
  if (shouldSplitOnBlur(changed)) {
    bumpFlushSeq(blockId)
    onWillSplit?.()
    const outcome = invokeSync(() => splitBlock(blockId, changed))
    return { kind: 'split', outcome }
  }

  // 2. Checkbox — a leading GFM task marker folds into `todo_state`.
  const { cleanContent, todoState } = processCheckboxSyntax(changed)
  if (todoState) {
    const mySeq = bumpFlushSeq(blockId)
    const outcome = commitCheckboxState({
      blockId,
      content: changed,
      cleanContent,
      todoState,
      mySeq,
      edit,
      pageStore,
      rootParentId,
    })
    return { kind: 'checkbox', outcome }
  }

  // 3. Inline `key:: value` properties.
  const inlineProps = parseInlineProperties(changed)
  if (inlineProps.length > 0) {
    const mySeq = bumpFlushSeq(blockId)
    const outcome = commitInlineProperties({
      blockId,
      content: changed,
      inlineProps,
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
