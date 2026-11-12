/**
 * In-page find over block text (#6557).
 *
 * A page's rows are mostly not in the DOM: off-screen rows are empty
 * placeholders, rows past the mount cap and children of a collapsed block are
 * not mounted at all. So matches are counted over the page store's blocks, as
 * the text each block renders, and painted only in the rows that are hydrated.
 *
 * A match is `{ blockId, start, end }` over {@link blockFindText}. Painting
 * re-runs the same matcher over the hydrated row's own DOM text and takes the
 * k-th DOM match for the block's k-th match, so a small difference between the
 * derived text and what the row draws (a footnote number) moves a
 * highlight within its block rather than breaking it.
 */

import type { StoreApi } from 'zustand'

import { parse } from '@/editor/markdown-serializer'
import { parseEmbedToken } from '@/lib/embed-token'
import type { CompiledQuery, FindMatch } from '@/lib/in-page-find/matcher'
import { REGEX_NODE_MAX, REGEX_TIME_BUDGET_MS } from '@/lib/in-page-find/matcher'
import { getPageDisplayName } from '@/lib/page-display'
import type { FlatBlock } from '@/lib/tree-utils'
import { mountedTreeStores } from '@/stores/block-command-bus'
import type { PageBlockState } from '@/stores/page-blocks'

export interface BlockFindMatch {
  blockId: string
  start: number
  end: number
}

export interface BlockFindResult {
  matches: BlockFindMatch[]
  /** Blocks skipped because their text exceeded `REGEX_NODE_MAX` in regex mode. */
  skippedLongNodes: number
  /** The regex scan stopped on its time budget; `matches` is partial. */
  timedOut: boolean
}

type ScanQuery = Extract<CompiledQuery, { kind: 'literal' | 'regex' }>

interface MarkdownNode {
  type: string
  text?: string
  attrs?: { id?: string; label?: string }
  content?: readonly MarkdownNode[]
}

const TEXTBLOCKS = new Set(['paragraph', 'heading', 'codeBlock'])

function nodeText(node: MarkdownNode, resolveTitle: (id: string) => string): string {
  const id = node.attrs?.id ?? ''
  switch (node.type) {
    case 'text': {
      return node.text ?? ''
    }
    case 'tag_ref':
    case 'block_ref': {
      return resolveTitle(id)
    }
    case 'block_link': {
      // The chip shows the stored label, else the title's leaf (`blockLink.tsx`).
      return node.attrs?.label ?? getPageDisplayName(resolveTitle(id), 'leaf').label
    }
    case 'hardBreak': {
      return '\n'
    }
  }
  const parts = (node.content ?? []).map((child) => nodeText(child, resolveTitle))
  // The renderer puts a space between block-level nodes (`RichContentRenderer`).
  return parts.join(TEXTBLOCKS.has(node.type) ? '' : ' ')
}

/**
 * The text `StaticBlock` shows for `content`. A query or embed block shows
 * results, not its text, so it has none to find.
 */
export function blockFindText(
  content: string | null,
  resolveTitle: (id: string) => string,
): string {
  if (!content) return ''
  if (parseEmbedToken(content) !== null) return ''
  if (content.startsWith('{{query ') && content.endsWith('}}')) return ''
  return nodeText(parse(content) as MarkdownNode, resolveTitle)
}

/** Every match of `compiled` over `blocks`, in block order. */
export function findInBlocks(
  blocks: ReadonlyArray<{ id: string; text: string }>,
  compiled: ScanQuery,
  options: { timeBudgetMs?: number; now?: () => number } = {},
): BlockFindResult {
  const now = options.now ?? Date.now
  const budget = options.timeBudgetMs ?? REGEX_TIME_BUDGET_MS
  const isRegex = compiled.kind === 'regex'
  const startedAt = isRegex ? now() : 0
  const matches: BlockFindMatch[] = []
  let skippedLongNodes = 0
  for (const block of blocks) {
    if (isRegex && now() - startedAt > budget) {
      return { matches, skippedLongNodes, timedOut: true }
    }
    if (isRegex && block.text.length > REGEX_NODE_MAX) {
      skippedLongNodes += 1
      continue
    }
    for (const r of compiled.matcher(block.text)) {
      matches.push({ blockId: block.id, start: r.start, end: r.end })
    }
  }
  return { matches, skippedLongNodes, timedOut: false }
}

/**
 * Text a row draws that is not the block's content: list markers, the empty-block hint,
 * screen-reader labels, and KaTeX's hidden MathML copy (it holds the LaTeX source).
 */
const NOT_CONTENT =
  '[aria-hidden="true"], .block-placeholder, .sr-only, .katex-mathml, [data-find-skip]'

function contentTextNodes(root: Element): Text[] {
  const out: Text[] = []
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const text = n as Text
    if (!text.nodeValue) continue
    const parent = text.parentElement
    if (parent === null || parent.closest(NOT_CONTENT)) continue
    out.push(text)
  }
  return out
}

/**
 * The matches of `compiled` in a hydrated row's content element, over its
 * text nodes joined, so a match may start in one node and end in another
 * (a query across a bold boundary).
 */
export function domMatchesIn(root: Element, compiled: ScanQuery): FindMatch[] {
  const nodes = contentTextNodes(root)
  const starts: number[] = []
  let joined = ''
  for (const node of nodes) {
    starts.push(joined.length)
    joined += node.nodeValue ?? ''
  }
  // The text node holding offset `at` and the offset within it. `end` offsets
  // resolve to the node the match ends in, not the start of the next one.
  const locate = (at: number, isEnd: boolean): [Text, number] | null => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const start = starts[i] as number
      if (isEnd ? at > start : at >= start) return [nodes[i] as Text, at - start]
    }
    return null
  }
  const out: FindMatch[] = []
  for (const r of compiled.matcher(joined)) {
    const from = locate(r.start, false)
    const to = locate(r.end, true)
    if (from === null || to === null) continue
    out.push({ node: from[0], start: from[1], endNode: to[0], end: to[1] })
  }
  return out
}

/** The mounted `BlockTree` stores with a row inside `container`, in DOM order. */
function treeStoresIn(container: Element): StoreApi<PageBlockState>[] {
  const owner = new Map<string, StoreApi<PageBlockState>>()
  for (const store of mountedTreeStores()) {
    for (const block of store.getState().blocks) owner.set(block.id, store)
  }
  const ordered: StoreApi<PageBlockState>[] = []
  if (owner.size === 0) return ordered
  for (const row of container.querySelectorAll('li[data-block-id]')) {
    const store = owner.get(row.getAttribute('data-block-id') ?? '')
    if (store !== undefined && !ordered.includes(store)) ordered.push(store)
  }
  return ordered
}

/** Whether `container` shows a block tree, so find searches block text there. */
export function holdsBlockTree(container: Element): boolean {
  return treeStoresIn(container).length > 0
}

/**
 * The blocks of every mounted `BlockTree` with a row inside `container`, in
 * tree order, each as {@link blockFindText}; `null` when the container holds
 * no tree (page mode, a journal month grid), which find then walks as DOM.
 */
export function blockSources(
  container: Element,
  textOf: (block: FlatBlock) => string,
): Array<{ id: string; text: string }> | null {
  const stores = treeStoresIn(container)
  if (stores.length === 0) return null
  return stores.flatMap((store) =>
    store.getState().blocks.map((block) => ({ id: block.id, text: textOf(block) })),
  )
}

/** The content element of every hydrated row in `container`, by block id. */
function contentRoots(container: Element): Map<string, Element> {
  const roots = new Map<string, Element>()
  const selector =
    '[data-testid="block-static"][data-block-id], [data-testid="block-editor"][data-block-id]'
  for (const el of container.querySelectorAll(selector)) {
    const id = el.getAttribute('data-block-id') ?? ''
    if (roots.has(id)) continue
    const root = el.matches('[data-testid="block-editor"]') ? el.querySelector('.ProseMirror') : el
    if (root !== null) roots.set(id, root)
  }
  return roots
}

/**
 * The DOM ranges of `matches` whose rows are hydrated, and the index among
 * them of match `currentIndex` (-1 when its row is not hydrated).
 */
export function paintableMatches(
  container: Element,
  matches: readonly BlockFindMatch[],
  compiled: ScanQuery,
  currentIndex: number,
): { painted: FindMatch[]; current: number } {
  const roots = contentRoots(container)
  const painted: FindMatch[] = []
  let current = -1
  let i = 0
  while (i < matches.length) {
    const blockId = (matches[i] as BlockFindMatch).blockId
    let end = i
    while (end < matches.length && (matches[end] as BlockFindMatch).blockId === blockId) end++
    const root = roots.get(blockId)
    if (root !== undefined) {
      const found = domMatchesIn(root, compiled)
      for (let k = 0; k < end - i && k < found.length; k++) {
        if (i + k === currentIndex) current = painted.length
        painted.push(found[k] as FindMatch)
      }
    }
    i = end
  }
  return { painted, current }
}
