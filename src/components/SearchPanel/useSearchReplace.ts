/**
 * Replace across pages from the search view (#6608).
 *
 * The search box's text is the literal text to find, with the case and
 * whole-word toggles. Search only supplies the candidates: the text goes to it
 * as quoted phrases with the toggles off, a superset the in-page matcher then
 * narrows, so a replace here changes what the in-page replace would. Every
 * candidate is loaded before a replace can run, and a search with too many is
 * refused: a run never does part of the matches.
 *
 * Each ticked block's new text is computed here (`replaceAllInContent`) and
 * all are written by one `edit_blocks_batch`, which leaves alone a block whose
 * content is no longer what the search returned.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { SearchToggleState } from '@/components/search/SearchToggleRow'
import { reloadChangedPageStores } from '@/hooks/useSyncEvents'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { OpRef, SearchBlockRow } from '@/lib/bindings'
import { blockFindText } from '@/lib/in-page-find/block-text'
import { type CompiledQuery, compileQuery } from '@/lib/in-page-find/matcher'
import {
  replaceableRanges,
  replaceAllInContent,
  type ReplaceSpec,
} from '@/lib/in-page-find/replace'
import { MAX_BATCH_BLOCK_IDS } from '@/lib/ipc-helpers'
import { notify } from '@/lib/notify'
import { reportIpcError } from '@/lib/report-ipc-error'
import type { SearchQueryAST } from '@/lib/search-query'
import { useResolveStore } from '@/stores/resolve'

type ScanQuery = Extract<CompiledQuery, { kind: 'literal' }>

/** The trigram index finds nothing for a shorter text. */
const MIN_FIND_LENGTH = 3

const CANDIDATE_TOGGLES: SearchToggleState = {
  caseSensitive: false,
  wholeWord: false,
  isRegex: false,
}

const resolveTitle = (id: string): string => useResolveStore.getState().resolveTitle(id)
const textOf = (content: string): string => blockFindText(content, resolveTitle)

/** What a replace would do to one block. */
export interface RowMatches {
  /** The text the block shows, which the ranges index. */
  text: string
  /** The matches a replace rewrites. */
  ranges: Array<{ start: number; end: number }>
  /** Matches in a link, tag or block reference, left as they are. */
  skipped: number
}

const NO_MATCHES: RowMatches = { text: '', ranges: [], skipped: 0 }

/** The text to find: the search's free text, or the inside of its one quoted phrase. */
export function findTextOf(freeText: string): string {
  const quoted = /^"([^"]*)"$/.exec(freeText)
  return quoted?.[1] ?? freeText
}

/**
 * The search query whose results hold every block showing `find`, or `null`
 * when the index cannot answer it. A phrase cannot hold a quote, so the text
 * goes as the phrases around its quotes.
 */
export function candidateQuery(find: string): string | null {
  const phrases = find
    .split('"')
    .filter((part) => Array.from(part.trim()).length >= MIN_FIND_LENGTH)
  return phrases.length === 0 ? null : phrases.map((part) => `"${part}"`).join(' ')
}

// Rows keep their identity while a result set stands, so each is matched once per query.
const matched = new WeakMap<SearchBlockRow, { scan: ScanQuery; matches: RowMatches }>()

function matchesIn(row: SearchBlockRow, scan: ScanQuery | null): RowMatches {
  if (scan === null || row.block_type !== 'content' || row.content === null) return NO_MATCHES
  const held = matched.get(row)
  if (held?.scan === scan) return held.matches
  const text = textOf(row.content)
  const { applied, skipped } = replaceableRanges(row.content, scan.matcher(text), resolveTitle)
  const matches = { text, ranges: applied, skipped }
  matched.set(row, { scan, matches })
  return matches
}

export interface SearchReplaceMode {
  open: boolean
  /** Open or close the row; `onClose` runs when it closes. */
  toggle: (onClose: () => void) => void
  replacement: string
  setReplacement: (value: string) => void
  /** Why this search cannot be replaced in, while the row is open. */
  unavailable: 'regex' | 'tooShort' | null
  /** The row is open and the search can be replaced in. */
  active: boolean
  find: string
  /** The in-page matcher for `find`, under the case and whole-word toggles. */
  scan: ScanQuery | null
  /** The search to run for candidates, in place of the typed one. */
  searchAst: SearchQueryAST
  searchToggles: SearchToggleState
  matchesOf: (row: SearchBlockRow) => RowMatches
  /** A page title or tag name the text occurs in: found, never rewritten. */
  isNameMatch: (row: SearchBlockRow) => boolean
  /** Every previewed row is ticked until the user unticks it. */
  isTicked: (blockId: string) => boolean
  /** What the result list takes while replace is active: only the rows it changes, ticked on select. */
  rowOptions: {
    keepRow?: (row: SearchBlockRow) => boolean
    onSelectRow?: (row: SearchBlockRow) => void
  }
  /** The result list's preview, while replace is active. */
  preview: ReplacePreview | undefined
}

/** What the result list draws in place of its rows: each block's change, and its tick. */
export interface ReplacePreview {
  matchesOf: (row: SearchBlockRow) => RowMatches
  replacement: string
  isTicked: (blockId: string) => boolean
  onToggleRow: (blockId: string) => void
  /** Tick or untick every row in `blockIds`. */
  onSetTicked: (blockIds: string[], ticked: boolean) => void
}

/** The replace row's state, and the candidate search it swaps in for the typed one. */
export function useSearchReplaceMode(
  ast: SearchQueryAST,
  toggles: SearchToggleState,
): SearchReplaceMode {
  const [open, setOpen] = useState(false)
  const [replacement, setReplacement] = useState('')
  const find = findTextOf(ast.freeText)
  const candidates = candidateQuery(find)
  const unavailable = !open
    ? null
    : toggles.isRegex
      ? 'regex'
      : candidates === null
        ? 'tooShort'
        : null
  const active = open && unavailable === null

  const { caseSensitive, wholeWord } = toggles
  const scan = useMemo<ScanQuery | null>(() => {
    const compiled = compileQuery(find, { caseSensitive, wholeWord, isRegex: false })
    return compiled.kind === 'literal' ? compiled : null
  }, [find, caseSensitive, wholeWord])

  const matchesOf = (row: SearchBlockRow): RowMatches => matchesIn(row, scan)
  // Stable per query: the result list filters with it on every render.
  const keepRow = useCallback(
    (row: SearchBlockRow) => matchesIn(row, scan).ranges.length > 0,
    [scan],
  )

  // The rows the user unticked, for the query they were unticked under.
  const tickKey = JSON.stringify([find, caseSensitive, wholeWord])
  const [unticked, setUnticked] = useState<{ key: string; ids: ReadonlySet<string> }>({
    key: tickKey,
    ids: new Set(),
  })
  const untickedIds = unticked.key === tickKey ? unticked.ids : new Set<string>()
  const setTicked = (blockIds: string[], on: boolean): void => {
    const ids = new Set(untickedIds)
    for (const id of blockIds) {
      if (on) ids.delete(id)
      else ids.add(id)
    }
    setUnticked({ key: tickKey, ids })
  }
  const isTicked = (blockId: string): boolean => !untickedIds.has(blockId)
  const toggleRow = (blockId: string): void => setTicked([blockId], untickedIds.has(blockId))

  const searchAst = useMemo(
    () => (active && candidates !== null ? { ...ast, freeText: candidates } : ast),
    [active, candidates, ast],
  )

  return {
    open,
    toggle: (onClose) => {
      setOpen(!open)
      if (open) onClose()
    },
    replacement,
    setReplacement,
    unavailable,
    active,
    find,
    scan,
    searchAst,
    searchToggles: active ? CANDIDATE_TOGGLES : toggles,
    matchesOf,
    isNameMatch: (row) =>
      scan !== null &&
      row.block_type !== 'content' &&
      row.content !== null &&
      scan.matcher(row.content).length > 0,
    isTicked,
    rowOptions: active ? { keepRow, onSelectRow: (row) => toggleRow(row.id) } : {},
    preview: active
      ? { matchesOf, replacement, isTicked, onToggleRow: toggleRow, onSetTicked: setTicked }
      : undefined,
  }
}

export type ReplacePreviewState =
  /** Candidates are still arriving. */
  | { kind: 'loading' }
  /** More blocks match than one run may write, or than the search can list. */
  | { kind: 'tooMany' }
  | { kind: 'ready'; blocks: number; pages: number }

export interface SearchReplace {
  state: ReplacePreviewState
  /** Matches in links, tags and block references, which stay as they are. */
  skippedMatches: number
  /** Page titles and tag names the text occurs in, which stay as they are. */
  skippedNames: number
  busy: boolean
  /** Write every ticked row. Resolves once the run has been reported. */
  run: () => Promise<void>
}

function pageIdsOf(rows: SearchBlockRow[]): string[] {
  return [...new Set(rows.map((row) => row.page_id ?? row.id))]
}

/** The preview over the loaded candidates, and the run that writes it. */
export function useSearchReplace({
  mode,
  toggles,
  candidates,
  searchLoading,
  hasMore,
  capped,
  loadMore,
  reload,
}: {
  mode: SearchReplaceMode
  toggles: SearchToggleState
  /** Every row the candidate search has loaded. */
  candidates: SearchBlockRow[]
  searchLoading: boolean
  hasMore: boolean
  capped: boolean
  loadMore: () => void
  reload: () => void
}): SearchReplace {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const { matchesOf, isNameMatch, isTicked, active } = mode
  const replaceable = active ? candidates.filter((row) => matchesOf(row).ranges.length > 0) : []
  const skippedMatches = active ? candidates.reduce((n, row) => n + matchesOf(row).skipped, 0) : 0
  const skippedNames = active ? candidates.filter(isNameMatch).length : 0
  const ticked = replaceable.filter((row) => isTicked(row.id))
  const tooMany = capped || replaceable.length > MAX_BATCH_BLOCK_IDS

  // A replace needs every candidate, so the pages are fetched without being asked for.
  useEffect(() => {
    if (active && hasMore && !searchLoading && !tooMany) loadMore()
  }, [active, hasMore, searchLoading, tooMany, loadMore])

  const state: ReplacePreviewState = tooMany
    ? { kind: 'tooMany' }
    : searchLoading || hasMore
      ? { kind: 'loading' }
      : { kind: 'ready', blocks: ticked.length, pages: pageIdsOf(ticked).length }

  const counts = (rows: SearchBlockRow[]) => ({
    blocks: t('search.replace.blocks', { count: rows.length }),
    pages: t('search.replace.pages', { count: pageIdsOf(rows).length }),
  })

  const undo = async (opRefs: OpRef[], pageIds: string[]): Promise<void> => {
    try {
      unwrap(await commands.undoOps(opRefs))
      reloadChangedPageStores(pageIds)
      reload()
    } catch (err) {
      reportIpcError('SearchReplace', 'search.replace.undoFailed', err, t)
    }
  }

  const run = async (): Promise<void> => {
    const { scan } = mode
    if (state.kind !== 'ready' || ticked.length === 0 || busy || scan === null) return
    const spec: ReplaceSpec = {
      query: mode.find,
      toggles: { ...toggles, isRegex: false },
      replacement: mode.replacement,
    }
    setBusy(true)
    try {
      const edits = ticked.map((row) => ({
        blockId: row.id,
        expected: row.content ?? '',
        toText: replaceAllInContent(row.content ?? '', scan, spec, textOf, resolveTitle).content,
      }))
      const { skipped, op_refs } = unwrap(await commands.editBlocksBatch(edits))
      const left = new Set(skipped)
      const written = ticked.filter((row) => !left.has(row.id))
      const pageIds = pageIdsOf(written)
      const message = [
        written.length > 0 ? t('search.replace.done', counts(written)) : null,
        skipped.length > 0 ? t('search.replace.changedSince', { count: skipped.length }) : null,
      ]
        .filter((part) => part !== null)
        .join(' · ')
      if (written.length === 0) {
        notify.info(message)
      } else {
        notify.success(message, {
          action: { label: t('action.undo'), onClick: () => void undo(op_refs, pageIds) },
        })
        reloadChangedPageStores(pageIds)
      }
      reload()
    } catch (err) {
      reportIpcError('SearchReplace', 'search.replace.failed', err, t, { blocks: ticked.length })
    } finally {
      setBusy(false)
    }
  }

  return {
    state,
    skippedMatches,
    skippedNames,
    busy,
    run,
  }
}
