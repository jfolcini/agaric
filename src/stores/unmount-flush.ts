/**
 * The shared post-`unmount()` decision chain (#3278): a split, else the task
 * marker, inline properties and tags written as text that the edit typed, all
 * committed on one leave as page mode does, else a plain edit. Every
 * unmount-triggered save (`useEditorBlur`, EditableBlock's `persistUnmount`,
 * `useBlockFlush`) goes through it, so one user action cannot fold a marker on
 * one path and save it verbatim on another.
 *
 * The chain acts only on what the edit added (#5160): each branch compares
 * `changed` with `loaded`, the content the editor mounted with (or last
 * committed). A block loaded with several paragraphs, a `key:: value` line or
 * a task marker (from Source, import or paste) keeps them after a typo fix;
 * the same shapes typed in are split, extracted or folded. Tags written as text
 * are the exception: import, paste and Source read every `#name` as a tag, so
 * the flush does too. `classifyUnmountFlush` is the decision alone, shared with
 * the debounced commit, which must skip exactly the edits this chain would not
 * save as a plain edit.
 *
 * Caller hooks: `invokeSync` wraps the synchronous split and edit calls (the
 * blur path's `flushSync`), never the async branches. `onWillSplit` fires just
 * before `splitBlock`, to capture state before the split lands. `dedupe` skips
 * a plain edit byte-identical to one already issued (#1062); the other branches
 * always run, as their processing has not happened on the early raw copy.
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

// Saves whose text write lands only after an IPC answers (the checkbox and
// property branches), by block id (#5448). Until then the page store shows the
// pre-edit content, blank for a new block, so the empty-block cleanup awaits
// this (`settlePendingSaves`) rather than delete under the commit.
const pendingSaves = new Map<string, Promise<boolean>>()

function trackPendingSave(blockId: string, outcome: Promise<boolean>): Promise<boolean> {
  pendingSaves.set(blockId, outcome)
  // By identity, so a newer save that replaced this entry is kept.
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
  /** The content the editor mounted with, or last committed; read before `unmount()` resets it. */
  loaded: string
  /** The unmounted content; callers check `unmount()` did not return null. */
  changed: string
  edit: (blockId: string, content: string) => Promise<boolean> | void
  splitBlock: (blockId: string, content: string) => Promise<boolean> | void
  rootParentId: string | null
  /** Needed only for the checkbox branch's optimistic write. */
  pageStore?: PageBlockStoreLike | undefined
  /** Wraps the split/edit branches' synchronous store call. Default: plain call. */
  invokeSync?: <T>(fn: () => T) => T
  /** Fires just before `splitBlock` in the split branch. */
  onWillSplit?: () => void
  /** Skips the plain edit when `changed` matches (#1062). */
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

  // 1. Split: the blocks the edit added win; a marker or property line in one
  //    of them is folded when that block is next flushed.
  if (classified.kind === 'split') {
    bumpFlushSeq(blockId)
    onWillSplit?.()
    const outcome = invokeSync(() => splitBlock(blockId, changed))
    return { kind: 'split', outcome }
  }

  // 2–4. The marker, then property lines, then tags, each on the text the one
  //      before wrote, as page mode's leave does.
  if (classified.kind !== 'edit') {
    const mySeq = bumpFlushSeq(blockId)
    const typed = commitTyped(deps, classified, mySeq, invokeSync)
    // The marker and property commits write the text only after their IPCs answer.
    const outcome = classified.kind === 'tag' ? typed : trackPendingSave(blockId, typed)
    return { kind: classified.kind, outcome }
  }

  // 5. Plain edit.
  if (dedupe && dedupe.content === changed) {
    return { kind: 'edit', outcome: dedupe.outcome }
  }
  bumpFlushSeq(blockId)
  const outcome = invokeSync(() => edit(blockId, changed))
  return { kind: 'edit', outcome }
}

/**
 * Commit the task marker, `key:: value` lines and tags the edit typed, in that
 * order, each on the text the one before wrote. A failed text write does not
 * stop the property commit, whose write carries that text too; tags wait for
 * saved text. Stops once a newer save started. Resolves `false` only when the
 * last step's text was not saved.
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
