/**
 * useInPageReplace — the replace half of in-page find (#6608).
 *
 * Where the bar searches block trees, a replace rewrites each changed block's
 * stored text through the page store's `edit`, the save a typed edit makes,
 * after the focused block's pending typing is flushed. Replace all is one undo
 * entry per page: its edits share an undo group, the first starting it, so
 * one Ctrl+Z puts back every block it changed. A failed save stops the run,
 * leaving the blocks after it as they were.
 *
 * In page mode the page is one editor, which the bar searches as DOM text: a
 * replace is one transaction in that editor, saved as typing is, undone by one
 * undo in it. Nothing else (source mode, the journal's month grid) can be
 * replaced in.
 */

import { useEffect, useRef, useState } from 'react'

import { reloadBaseline, takeReloadedText } from '@/editor/active-editor'
import { flushActiveDraft } from '@/lib/active-draft-flush'
import { type BlockFindMatch, blockFindText } from '@/lib/in-page-find/block-text'
import { type CompiledQuery, compileQuery, type FindMatch } from '@/lib/in-page-find/matcher'
import {
  replaceAllInContent,
  replaceInContent,
  replacementFor,
  type ReplaceSpec,
  skippedMatches,
} from '@/lib/in-page-find/replace'
import {
  pageModeEditorIn,
  replaceInEditor,
  skippedInEditor,
} from '@/lib/in-page-find/replace-in-editor'
import { logger } from '@/lib/logger'
import { treeStoresIn } from '@/stores/block-command-bus'
import { useResolveStore } from '@/stores/resolve'
import { type InPageFindToggles, useInPageFindStore } from '@/stores/useInPageFindStore'

/** Where find goes after a replace: past the text put in, or a DOM match's index. */
export type ReplaceCursor =
  | { kind: 'block'; blockId: string; offset: number }
  | { kind: 'dom'; index: number }

export type ReplaceOutcome =
  | { kind: 'done'; replaced: number; skipped: number }
  | { kind: 'failed'; replaced: number }

type ScanQuery = Extract<CompiledQuery, { kind: 'literal' | 'regex' }>

/** Every replace-all edit carries this key, so a run's edits on a page join one undo entry. */
const REPLACE_ALL_UNDO_GROUP = 'in-page-replace-all'

const resolveTitle = (id: string): string => useResolveStore.getState().resolveTitle(id)

function storeOf(container: Element, blockId: string) {
  return treeStoresIn(container).find((store) => store.getState().blocksById.has(blockId))
}

/** Write `content` to `blockId`, then hand it to a roving editor still on the block. */
async function saveBlock(
  container: Element,
  blockId: string,
  content: string,
  options: { merge?: boolean; undoGroup?: string },
): Promise<boolean> {
  const store = storeOf(container, blockId)
  if (store === undefined) return false
  const baseline = reloadBaseline(blockId)
  const saved = await store.getState().edit(blockId, content, options)
  // Only once saved: an editor holding refused text would commit it on the next keystroke.
  if (saved) takeReloadedText(blockId, content, baseline)
  return saved
}

/** How many of the matches find holds a replace would leave as they are. */
function countUnreplaceable(
  container: Element,
  blockMatches: BlockFindMatch[] | null,
  domMatches: () => FindMatch[],
): number {
  if (blockMatches === null) {
    const editor = pageModeEditorIn(container)
    return editor === null ? 0 : skippedInEditor(editor, domMatches())
  }
  const byBlock = new Map<string, BlockFindMatch[]>()
  for (const m of blockMatches) byBlock.set(m.blockId, [...(byBlock.get(m.blockId) ?? []), m])
  let skipped = 0
  for (const [blockId, ranges] of byBlock) {
    const content = storeOf(container, blockId)?.getState().blocksById.get(blockId)?.content
    skipped += skippedMatches(content ?? null, ranges, resolveTitle)
  }
  return skipped
}

export function useInPageReplace({
  replaceOpen,
  container,
  query,
  toggles,
  replacement,
  currentIndex,
  totalMatches,
  blocksVersion,
  blockMatches,
  domMatches,
  next,
  onReplaced,
}: {
  replaceOpen: boolean
  container: HTMLElement | null
  query: string
  toggles: InPageFindToggles
  replacement: string
  currentIndex: number
  totalMatches: number
  blocksVersion: number
  /** The matches over block text, or `null` while find walks the DOM. */
  blockMatches: () => BlockFindMatch[] | null
  domMatches: () => FindMatch[]
  next: () => void
  onReplaced: (cursor: ReplaceCursor) => void
}) {
  const [busy, setBusy] = useState(false)
  // The last outcome, for the query, toggles and replacement it ran with.
  const [last, setLast] = useState<{ key: string; outcome: ReplaceOutcome } | null>(null)
  const unreplaceable = useInPageFindStore((s) => s.unreplaceable)
  const runningRef = useRef(false)

  const runKey = JSON.stringify([query, toggles, replacement])
  const outcome = last?.key === runKey ? last.outcome : null
  const spec: ReplaceSpec = { query, toggles, replacement }
  const compiled = compileQuery(query, toggles)
  const scan: ScanQuery | null =
    compiled.kind === 'literal' || compiled.kind === 'regex' ? compiled : null
  const available =
    container !== null &&
    (treeStoresIn(container).length > 0 || pageModeEditorIn(container) !== null)

  // The matches find counts that a replace would leave, kept with the counter in the find store.
  useEffect(() => {
    const count =
      replaceOpen && container !== null && totalMatches > 0
        ? countUnreplaceable(container, blockMatches(), domMatches)
        : 0
    useInPageFindStore.setState({ unreplaceable: count })
  }, [
    replaceOpen,
    container,
    query,
    toggles,
    totalMatches,
    blocksVersion,
    blockMatches,
    domMatches,
  ])

  const run = async (work: () => Promise<ReplaceOutcome | null>): Promise<void> => {
    if (runningRef.current) return
    runningRef.current = true
    setBusy(true)
    try {
      const result = await work()
      if (result !== null) setLast({ key: runKey, outcome: result })
    } catch (err) {
      logger.error('in-page-replace', 'replace failed', undefined, err)
      setLast({ key: runKey, outcome: { kind: 'failed', replaced: 0 } })
    } finally {
      runningRef.current = false
      setBusy(false)
    }
  }

  const replaceCurrent = (): Promise<void> =>
    run(async () => {
      if (container === null || scan === null || currentIndex < 0) return null
      const matches = blockMatches()
      if (matches === null) {
        const editor = pageModeEditorIn(container)
        const match = domMatches()[currentIndex]
        if (editor === null || match === undefined) return null
        const text = replacementFor(match.node.nodeValue ?? '', match, spec)
        const result = replaceInEditor(editor, [{ match, text }])
        if (result.replaced === 0) next()
        // The replaced match is gone; a replacement that matches again is stepped past.
        else onReplaced({ kind: 'dom', index: currentIndex + scan.matcher(text).length })
        return { kind: 'done', ...result }
      }
      const match = matches[currentIndex]
      if (match === undefined) return null
      await flushActiveDraft()
      const content = storeOf(container, match.blockId)
        ?.getState()
        .blocksById.get(match.blockId)?.content
      if (content == null) return null
      const text = blockFindText(content, resolveTitle)
      // The flush may have changed the block; find runs again on its own.
      if (!scan.matcher(text).some((r) => r.start === match.start && r.end === match.end)) {
        return null
      }
      const insert = replacementFor(text, match, spec)
      const result = replaceInContent(content, [{ ...match, text: insert }], resolveTitle)
      if (result.replaced === 0) {
        next()
        return { kind: 'done', replaced: 0, skipped: result.skipped }
      }
      onReplaced({ kind: 'block', blockId: match.blockId, offset: match.start + insert.length })
      const saved = await saveBlock(container, match.blockId, result.content, { merge: false })
      return saved ? { kind: 'done', replaced: 1, skipped: 0 } : { kind: 'failed', replaced: 0 }
    })

  const replaceAll = (): Promise<void> =>
    run(async () => {
      if (container === null || scan === null) return null
      if (blockMatches() === null) {
        const editor = pageModeEditorIn(container)
        if (editor === null) return null
        const items = domMatches().map((match) => ({
          match,
          text: replacementFor(match.node.nodeValue ?? '', match, spec),
        }))
        return { kind: 'done', ...replaceInEditor(editor, items) }
      }
      await flushActiveDraft()
      const textOf = (content: string) => blockFindText(content, resolveTitle)
      const plan: Array<{ blockId: string; pageId: string | null; content: string; n: number }> = []
      let skipped = 0
      for (const store of treeStoresIn(container)) {
        const { blocks, rootParentId } = store.getState()
        for (const block of blocks) {
          if (block.content === null) continue
          const result = replaceAllInContent(block.content, scan, spec, textOf, resolveTitle)
          skipped += result.skipped
          if (result.replaced > 0) {
            plan.push({ blockId: block.id, pageId: rootParentId, ...result, n: result.replaced })
          }
        }
      }
      let replaced = 0
      const started = new Set<string | null>()
      for (const step of plan) {
        const merge = started.has(step.pageId)
        started.add(step.pageId)
        const saved = await saveBlock(container, step.blockId, step.content, {
          merge,
          undoGroup: REPLACE_ALL_UNDO_GROUP,
        })
        if (!saved) return { kind: 'failed', replaced }
        replaced += step.n
      }
      return { kind: 'done', replaced, skipped }
    })

  return { available, busy, outcome, unreplaceable, replaceCurrent, replaceAll }
}
