/**
 * runUnmountFlush — the shared post-`unmount()` decision chain: a split, else
 * the task marker, inline properties and tags written as text the edit typed,
 * all of them on one leave as page mode commits them, else a plain edit (#3278).
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
 * A tag written as text is the exception: import, paste and Source read a
 * `#name` as the tag, so the flush makes every one a tag (#5160 follow-up 7a).
 * `classifyUnmountFlush` is that decision on its own, shared with the
 * debounced content commit, which must skip exactly the edits this chain
 * would not commit as a plain edit.
 *
 * This function performs the classification AND makes the actual store calls
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
import { parse } from '@/editor/markdown-parse'
import { processCheckboxSyntax } from '@/lib/block-utils'
import { type InlinePropertyLine, parseInlineProperties } from '@/lib/inline-property-parse'
import { scanNameTokens, type TagToken } from '@/lib/name-tokens'
import type { TodoState } from '@/lib/task-states'
import {
  bumpFlushSeq,
  commitCheckboxState,
  commitInlineProperties,
  commitTypedTags,
  type PageBlockStoreLike,
  readFlushSeq,
} from '@/stores/inline-property-commit'

// #5448 — the saves whose text write lands only after an IPC answers (the
// checkbox and property branches), keyed by block id. Until that write lands
// the page store still holds the block's pre-edit content — blank, for a new
// block the line was typed into — so BlockTree's empty-block cleanup awaits
// the entry (`settlePendingSaves`) before probing, instead of deleting the
// block out from under the commit. Module-level for the reason
// `flushSeqByBlock` is: the three save paths live in different components.
const pendingSaves = new Map<string, Promise<boolean>>()

function trackPendingSave(blockId: string, outcome: Promise<boolean>): Promise<boolean> {
  pendingSaves.set(blockId, outcome)
  // Guard on identity so a newer save that replaced this entry is kept.
  const settled = () => {
    if (pendingSaves.get(blockId) === outcome) pendingSaves.delete(blockId)
  }
  void outcome.then(settled, settled)
  return outcome
}

/** Resolves once no save of `blockId` that defers its text write is in flight. */
export async function settlePendingSaves(blockId: string): Promise<void> {
  for (let pending = pendingSaves.get(blockId); pending; pending = pendingSaves.get(blockId)) {
    await pending
  }
}

export type UnmountFlushResult =
  | { kind: 'split' | 'edit'; outcome: Promise<boolean> | void }
  | { kind: 'checkbox' | 'property' | 'tag'; outcome: Promise<boolean> }

/** The first of split, task marker, property line and tag the edit introduced, else a plain edit. */
export type UnmountFlushClassification =
  | { kind: 'split' | 'property' | 'tag' | 'edit' }
  | { kind: 'checkbox'; cleanContent: string; todoState: TodoState }

/** The `key:: value` lines of `changed` whose key `loaded` did not already carry. */
export function addedInlineProperties(loaded: string, changed: string): InlinePropertyLine[] {
  const added = parseInlineProperties(changed)
  if (added.length === 0) return added
  const loadedKeys = new Set(parseInlineProperties(loaded).map((prop) => prop.key))
  return added.filter((prop) => !loadedKeys.has(prop.key))
}

/**
 * What the flush does with `changed`, given the block was loaded as `loaded`:
 * the first branch whose shape the edit introduced, else a plain edit. The
 * flush commits that shape and every later one the edit also typed.
 */
export function classifyUnmountFlush(loaded: string, changed: string): UnmountFlushClassification {
  if (shouldSplitOnBlur(changed, loaded)) return { kind: 'split' }
  const { cleanContent, todoState } = processCheckboxSyntax(changed)
  if (todoState && !processCheckboxSyntax(loaded).todoState) {
    return { kind: 'checkbox', cleanContent, todoState }
  }
  if (addedInlineProperties(loaded, changed).length > 0) return { kind: 'property' }
  if (tagsWrittenAsText(changed).length > 0) return { kind: 'tag' }
  return { kind: 'edit' }
}

/**
 * The `#name` and `#[[name]]` tokens `content` holds as text, which import,
 * paste and Source read as tags; none when it holds a code block, which they
 * never read for names.
 */
export function tagsWrittenAsText(content: string): TagToken[] {
  const tags = scanNameTokens(content).filter((token): token is TagToken => token.kind === 'tag')
  if (tags.length === 0) return tags
  return parse(content).content?.some((node) => node.type === 'codeBlock') ? [] : tags
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

  // 2–4. What the edit typed: its task marker, then its `key:: value` lines,
  //      then its tags, each committed on the text the one before it wrote,
  //      as page mode's leave does.
  if (classified.kind !== 'edit') {
    const mySeq = bumpFlushSeq(blockId)
    const typed = commitTyped(deps, classified, mySeq, invokeSync)
    // The marker and property commits write the text only after their IPCs answer.
    const outcome = classified.kind === 'tag' ? typed : trackPendingSave(blockId, typed)
    return { kind: classified.kind, outcome }
  }

  // 5. Plain edit — with the #1062 dedup skip.
  if (dedupe && dedupe.content === changed) {
    return { kind: 'edit', outcome: dedupe.outcome }
  }
  bumpFlushSeq(blockId)
  const outcome = invokeSync(() => edit(blockId, changed))
  return { kind: 'edit', outcome }
}

/**
 * Commit the task marker, `key:: value` lines and tags the edit typed, in that
 * order, each on the text the commit before it wrote. A failed text write
 * does not stop the property commit, whose write carries that text too; the
 * tags wait for a saved text, as they always have. Stops once a newer save of
 * the block has started. Resolves `false` only when the step that wrote last
 * says its text was not saved, the helpers' draft-gating contract.
 */
async function commitTyped(
  deps: UnmountFlushDeps,
  classified: UnmountFlushClassification,
  mySeq: number,
  invokeSync: <T>(fn: () => T) => T,
): Promise<boolean> {
  const { blockId, loaded, changed, edit, pageStore, rootParentId, dedupe } = deps
  let content = changed
  let lastWrite: Promise<boolean> | void | undefined
  // The text each step writes is the next step's; the same text twice is one write.
  const write = (id: string, next: string): Promise<boolean> | void => {
    if (lastWrite !== undefined && next === content) return lastWrite
    content = next
    lastWrite = edit(id, next)
    return lastWrite
  }
  const current = () => readFlushSeq(blockId) === mySeq
  let ok = true
  if (classified.kind === 'checkbox') {
    ok = await commitCheckboxState({
      blockId,
      content,
      cleanContent: classified.cleanContent,
      todoState: classified.todoState,
      mySeq,
      edit: write,
      pageStore,
      rootParentId,
    })
    if (!current()) return true
  }
  const inlineProps = addedInlineProperties(loaded, content)
  if (inlineProps.length > 0) {
    ok = await commitInlineProperties({
      blockId,
      content,
      inlineProps,
      mySeq,
      edit: write,
      rootParentId,
    })
    if (!current()) return true
  }
  const tags = tagsWrittenAsText(content)
  if (tags.length === 0) return ok
  if (lastWrite === undefined) {
    lastWrite =
      dedupe?.content === changed ? dedupe.outcome : invokeSync(() => edit(blockId, changed))
  }
  return commitTypedTags({
    blockId,
    content,
    tags,
    textSaved: lastWrite,
    mySeq,
    edit: write,
  })
}
