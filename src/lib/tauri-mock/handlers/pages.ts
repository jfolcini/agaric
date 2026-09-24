/**
 * Tauri mock handlers -- Page listing, metadata query, creation, aliases, markdown import/export.
 *
 * Split out of the former monolithic `handlers.ts` (#2931). Every handler
 * body below is UNCHANGED from the original -- only relocated. Shared
 * mutable mock state (`blocks`, `opLog`, `properties`, ...) and cross-domain
 * helpers come from `./shared` / `@/lib/tauri-mock/seed`, the single source
 * every domain module reads and writes -- there is no per-domain copy of any
 * store.
 */

import { base64UrlToUtf8 } from '@/lib/base64url'
import { compareNocase, compareUtf8Bytes, foldAsciiUppercase } from '@/lib/sqlite-collation'
import { blocksHandlers, parseOutline } from '@/lib/tauri-mock/handlers/blocks'
import {
  type PageMetaRow,
  type TypedHandlers,
  appErrorRejection,
  buildPageMetaRow,
  compareMetaRows,
  comparePositionThenId,
  deriveLinkEdges,
  encodeNextCursor,
  findLivePageByTitle,
  metaRowMatchesFilter,
  notFoundRejection,
  sortDiscriminator,
  spaceRootGroup,
  validationRejection,
} from '@/lib/tauri-mock/handlers/shared'
import {
  blockTags,
  blocks,
  fakeId,
  makeBlock,
  pageAliases,
  properties,
  pushOp,
} from '@/lib/tauri-mock/seed'

/** The backend's `MCP_PAGE_LIMIT_CAP` for `list_pages_with_metadata`. */
const LIST_PAGES_WITH_METADATA_MAX_LIMIT = 100

/**
 * Validate `list_pages_with_metadata`'s `limit` the way the backend does —
 * REJECT an out-of-range ask rather than clamping it (AGENTS.md invariant 10:
 * "Pagination `limit` is validated, not clamped").
 *
 * This mirrored a `Math.min(..., 100)` clamp, and that is exactly how #4805
 * shipped: `PagesTreeSection` asked for 200, every mock-backed test quietly got
 * 100 and passed, and the real backend refused the call with a `Validation`
 * error, so the child-pages tree was dead for every user on every page. A mock
 * that accepts what the backend rejects trains callers on a contract that does
 * not exist.
 */
function listPagesWithMetadataLimit(raw: unknown): number {
  if (raw == null) return 50
  const limit = raw as number
  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_PAGES_WITH_METADATA_MAX_LIMIT) {
    throw validationRejection(
      `list_pages_with_metadata limit must be in [1, ${LIST_PAGES_WITH_METADATA_MAX_LIMIT}]; ` +
        `got ${String(limit)}`,
    )
  }
  return limit
}

/**
 * The dense 1-based rank a block appended to `parentId`'s children takes.
 *
 * Two rules the backend applies and a plain `siblings.length` does not.
 * Positions are DENSE and 1-BASED (`insertAtSlotAndRenumber`), and a
 * SOFT-DELETED sibling keeps its slot (#4669, #419), so tombstones count.
 *
 * At the ROOT the group is also per SPACE ({@link spaceRootGroup}), not the
 * whole `parent_id = NULL` set. That is why a new space comes out at 1 and the
 * first page created inside it at 2.
 *
 * The rank survives only until the next ROOT renumber: `insertAtSlotAndRenumber(null, …)`
 * densifies the whole cross-space `parent_id = null` group and overwrites it.
 */
function nextDenseRank(parentId: string | null, spaceId: string | null): number {
  if (parentId === null) return spaceRootGroup(spaceId).length + 1
  let siblings = 0
  for (const b of blocks.values()) {
    if ((b['parent_id'] as string | null) !== parentId) continue
    siblings += 1
  }
  return siblings + 1
}

type OpRefs = Array<{ device_id: string; seq: number }>

/** `parentId`'s live children in sibling order, hidden ones included. */
function liveChildren(parentId: string): Record<string, unknown>[] {
  return [...blocks.values()]
    .filter((b) => b['parent_id'] === parentId && !b['deleted_at'])
    .toSorted(comparePositionThenId)
}

/**
 * DELIBERATE APPROXIMATION of `render_page_source` (#5140): every live content
 * descendant, depth-first in sibling order, as `- content ^ID` with its further
 * lines indented under the bullet. Like the backend, a nested page and what is
 * under it are left out. No list markers, task checkboxes or property lines —
 * the Rust tests own that grammar, and a faithful port is the second
 * implementation #5140 deletes. Returns the buffer and the ids it holds, in
 * order.
 */
function renderPageSource(pid: string): { source: string; ids: string[] } {
  const page = blocks.get(pid)
  // Like the backend's `load_page_row`: a trashed page is not found, and a
  // block that is not a page is a validation error.
  if (!page || page['deleted_at']) throw notFoundRejection(`page '${pid}' not found`)
  if (page['block_type'] !== 'page') throw validationRejection('not a page')
  let source = ''
  const ids: string[] = []
  const render = (parentId: string, depth: number): void => {
    for (const child of liveChildren(parentId)) {
      if (child['block_type'] !== 'content') continue
      const id = child['id'] as string
      const [head, ...rest] = ((child['content'] as string | null) ?? '').split('\n')
      source += `${'  '.repeat(depth)}- ${head}`
      for (const line of rest) source += line === '' ? '\n' : `\n${'  '.repeat(depth + 1)}${line}`
      source += ` ^${id}\n`
      ids.push(id)
      render(id, depth + 1)
    }
  }
  render(pid, 0)
  return { source, ids }
}

interface SourceBullet {
  content: string
  depth: number
  anchor: string | null
}

/** The ` ^word` a source block ends with, when it is id-sized. */
const SOURCE_ANCHOR_RE = /(?:^|\s)\^([0-9A-Za-z]{26})\s*$/

/** What `BlockId::from_string` reads: Crockford base32, either case, in 128 bits. */
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i

/**
 * Whether a caret word is a block id: anything else is text, as the backend's
 * save keeps it. The mock's own ids (`…BLOCK01`, `…MOCK…`) spell letters
 * outside Crockford, so a word naming a block the mock holds is one too.
 */
function isBlockId(word: string): boolean {
  return ULID_RE.test(word) || blocks.has(word)
}

/** A source buffer's blocks ({@link parseOutline}), each trailing ` ^id` split off. */
function parseSourceBuffer(source: string): SourceBullet[] {
  return parseOutline(source).map(({ content, depth }) => {
    const match = SOURCE_ANCHOR_RE.exec(content)
    const word = match?.[1]
    return match && word !== undefined && isBlockId(word)
      ? { content: content.slice(0, match.index), depth, anchor: word }
      : { content, depth, anchor: null }
  })
}

/** A `^word` at a line start or after whitespace, as {@link SOURCE_ANCHOR_RE} reads a trailing one. */
const MOVED_ANCHOR_RE = /(?:^|\s)(\^[0-9A-Za-z-]+)/g

/**
 * Mirrors `heal_moved_anchors` (`markdown_source_apply.rs`): an unanchored
 * bullet whose text holds exactly one `^ID` of a `loaded` block no other
 * bullet claims takes it as its anchor, and the token leaves the text with the
 * one separator written with it. Two or more refuse the save. The mock models
 * no inline code, so the backend's inline-code skip has no counterpart.
 */
function healMovedAnchors(
  typed: SourceBullet[],
  loaded: ReadonlySet<string>,
  claimed: Set<string>,
): void {
  for (const bullet of typed) {
    if (bullet.anchor !== null) continue
    const tokens = [...bullet.content.matchAll(MOVED_ANCHOR_RE)]
      .map((match) => {
        const token = match[1] ?? ''
        return { token, start: match.index + match[0].length - token.length }
      })
      .filter(({ token }) => loaded.has(token.slice(1)) && !claimed.has(token.slice(1)))
    const [first, second] = tokens
    if (!first) continue
    if (second) {
      throw validationRejection(`${first.token} and ${second.token} are written in one block`)
    }
    const id = first.token.slice(1)
    bullet.content = withoutToken(bullet.content, first.start, first.start + first.token.length)
    bullet.anchor = id
    claimed.add(id)
  }
}

/**
 * `content` less the token at `start..end` and the one separator written with
 * it: the whitespace before it, or at a line start the space after it, or the
 * line break of a line that is the token alone.
 */
function withoutToken(content: string, start: number, end: number): string {
  let before = content.slice(0, start)
  let after = content.slice(end)
  if (before !== '' && !before.endsWith('\n')) before = before.slice(0, -1)
  else if (after.startsWith(' ')) after = after.slice(1)
  else if (after === '' || after.startsWith('\n')) {
    if (before.endsWith('\n')) before = before.slice(0, -1)
    else after = after.slice(1)
  }
  return before + after
}

/** The longest run of `ids` already in `rank` order: the ones that need no move. */
function longestInOrderRun(ids: string[], rank: ReadonlyMap<string, number>): Set<string> {
  interface Run {
    id: string
    length: number
    previous: Run | null
  }
  const runs: Run[] = []
  let longest: Run | null = null
  for (const id of ids) {
    const run: Run = { id, length: 1, previous: null }
    for (const earlier of runs) {
      if ((rank.get(earlier.id) ?? 0) < (rank.get(id) ?? 0) && earlier.length >= run.length) {
        run.length = earlier.length + 1
        run.previous = earlier
      }
    }
    runs.push(run)
    if (longest === null || run.length > longest.length) longest = run
  }
  const kept = new Set<string>()
  for (let run = longest; run !== null; run = run.previous) kept.add(run.id)
  return kept
}

/** One side of a source merge: each block by key, its parent's key, each parent's children. */
interface SourceOutline {
  byKey: Map<string, SourceBullet>
  parent: Map<string, string | null>
  children: Map<string | null, string[]>
}

/**
 * `bullets` as a tree keyed by anchor. An unanchored bullet is keyed
 * `new:<index>` when `keepUnanchored`, and otherwise left out, its children
 * going to its parent.
 */
function sourceOutline(bullets: SourceBullet[], keepUnanchored: boolean): SourceOutline {
  const outline: SourceOutline = { byKey: new Map(), parent: new Map(), children: new Map() }
  const open: Array<{ depth: number; key: string }> = []
  bullets.forEach((bullet, i) => {
    const key = bullet.anchor ?? (keepUnanchored ? `new:${i}` : null)
    if (key === null) return
    while ((open.at(-1)?.depth ?? -1) >= bullet.depth) open.pop()
    const parent = open.at(-1)?.key ?? null
    outline.byKey.set(key, bullet)
    outline.parent.set(key, parent)
    outline.children.set(parent, [...(outline.children.get(parent) ?? []), key])
    open.push({ depth: bullet.depth, key })
  })
  return outline
}

/** A block the merge keeps, and the buffer's version saved as a new block before it. */
interface MergedBlock {
  content: string
  anchor: string | null
  fork: string | null
}

/** A merge warning about a block, which it names by its first line cut to 40 characters. */
function warningAbout(content: string, what: string): string {
  const line = Array.from(content.split('\n')[0] ?? '')
  return `'${line.length > 40 ? `${line.slice(0, 40).join('')}…` : line.join('')}' ${what}`
}

/**
 * Which blocks a merge keeps and with what text. A block changed on one side
 * takes that side's text; changed on both, the page's stays and the buffer's
 * is forked as a new block before it. A delete on one side stands unless the
 * other side changed the block or moved it to another parent. DELIBERATE
 * APPROXIMATION: two different edits of a multi-line block fork here, where
 * the backend's `merge_lines` first tries to merge them line by line.
 */
function mergeSourceBlocks(
  base: SourceOutline,
  current: SourceOutline,
  mine: SourceOutline,
  warnings: string[],
): Map<string, MergedBlock> {
  const kept = new Map<string, MergedBlock>()
  const moved = (side: SourceOutline, key: string) => side.parent.get(key) !== base.parent.get(key)
  for (const [key, c] of current.byKey) {
    const b = base.byKey.get(key)
    const m = mine.byKey.get(key)
    if (m === undefined) {
      if (b?.content === c.content && !moved(current, key)) continue
      if (b !== undefined) {
        warnings.push(warningAbout(c.content, 'changed on the page; your delete was not applied'))
      }
      kept.set(key, { content: c.content, anchor: key, fork: null })
    } else if (c.content === m.content || m.content === b?.content) {
      kept.set(key, { content: c.content, anchor: key, fork: null })
    } else if (c.content === b?.content) {
      kept.set(key, { content: m.content, anchor: key, fork: null })
    } else {
      warnings.push(warningAbout(c.content, 'was changed here and on the page; both versions kept'))
      kept.set(key, { content: c.content, anchor: key, fork: m.content })
    }
  }
  for (const [key, m] of mine.byKey) {
    if (current.byKey.has(key)) continue
    const b = base.byKey.get(key)
    if (b === undefined) {
      kept.set(key, { content: m.content, anchor: m.anchor, fork: null })
    } else if (m.content !== b.content || moved(mine, key)) {
      warnings.push(warningAbout(m.content, 'was deleted on the page; saved as a new block'))
      kept.set(key, { content: m.content, anchor: null, fork: null })
    }
  }
  return kept
}

/** `key`'s parent in `side`, or its nearest ancestor there the merge keeps; null is the page. */
function keptAncestor(key: string, side: SourceOutline, kept: ReadonlyMap<string, unknown>) {
  let parent = side.parent.get(key) ?? null
  while (parent !== null && !kept.has(parent)) parent = side.parent.get(parent) ?? null
  return parent
}

/**
 * Each kept block's parent. A block the page moved keeps the page's parent, one
 * the buffer moved takes the buffer's, and one both moved differently keeps the
 * page's, with a warning; so does one the buffer's parent would make its own
 * ancestor. A parent the merge drops is replaced by its nearest kept ancestor
 * on the side the parent came from.
 */
function mergeSourceParents(
  outlines: { base: SourceOutline; current: SourceOutline; mine: SourceOutline },
  kept: ReadonlyMap<string, MergedBlock>,
  warnings: string[],
): Map<string, string | null> {
  const { base, current, mine } = outlines
  const parentOf = new Map<string, string | null>()
  for (const key of kept.keys()) {
    parentOf.set(key, keptAncestor(key, current.byKey.has(key) ? current : mine, kept))
  }
  const isAncestor = (key: string, of: string | null): boolean => {
    for (let at = of; at !== null; at = parentOf.get(at) ?? null) if (at === key) return true
    return false
  }
  for (const key of mine.byKey.keys()) {
    if (!kept.has(key) || !current.byKey.has(key)) continue
    const [b, c, m] = [base, current, mine].map((side) => side.parent.get(key))
    if (m === b || m === c) continue
    const theirs = keptAncestor(key, mine, kept)
    if (c !== b || isAncestor(key, theirs)) {
      const { content } = current.byKey.get(key) as SourceBullet
      warnings.push(warningAbout(content, "was moved here and on the page; the page's place kept"))
    } else {
      parentOf.set(key, theirs)
    }
  }
  return parentOf
}

/** `side`'s children of `parent`, a block the merge drops replaced by its own. */
function keptChildren(
  side: SourceOutline,
  parent: string | null,
  kept: ReadonlyMap<string, unknown>,
): string[] {
  return (side.children.get(parent) ?? []).flatMap((key) =>
    kept.has(key) ? [key] : keptChildren(side, key, kept),
  )
}

/**
 * `parent`'s children in merged order. The keys on all three sides decide
 * whose order is the skeleton: the page's when the buffer kept the base order,
 * otherwise the buffer's, with a warning when the page reordered them too.
 * Every child the skeleton lacks goes after the nearest child before it on its
 * own side that is already placed, or first.
 */
function mergeSourceOrder(
  outlines: { base: SourceOutline; current: SourceOutline; mine: SourceOutline },
  parent: string | null,
  parentOf: ReadonlyMap<string, string | null>,
  warnings: string[],
): string[] {
  const [b, c, m] = [outlines.base, outlines.current, outlines.mine].map((side) =>
    keptChildren(side, parent, parentOf).filter((key) => parentOf.get(key) === parent),
  ) as [string[], string[], string[]]
  const common = (list: string[]): string =>
    list.filter((key) => b.includes(key) && c.includes(key) && m.includes(key)).join()
  const [orderB, orderC, orderM] = [common(b), common(c), common(m)]
  if (orderC !== orderB && orderM !== orderB && orderC !== orderM) {
    const under =
      parent === null
        ? undefined
        : (outlines.current.byKey.get(parent) ?? outlines.mine.byKey.get(parent))
    warnings.push(
      under === undefined
        ? "the page's blocks were reordered here and on the page; your order kept"
        : `the blocks under ${warningAbout(under.content, 'were reordered here and on the page; your order kept')}`,
    )
  }
  const skeleton = orderM === orderB ? c : m
  const other = skeleton === c ? m : c
  const order = [...skeleton]
  for (const key of other) {
    if (order.includes(key)) continue
    const before = other.slice(0, other.indexOf(key)).findLast((k) => order.includes(k))
    order.splice(before === undefined ? 0 : order.indexOf(before) + 1, 0, key)
  }
  return order
}

/**
 * The buffer with what changed on the page since `base` folded in (#5140
 * Phase 5): blocks by anchor, text, parent and order each merged three ways,
 * as `mergeSourceBlocks`, `mergeSourceParents` and `mergeSourceOrder` say.
 * Bullets in pre-order, depth from the merged tree.
 */
function mergeSourceBuffer(
  base: SourceBullet[],
  current: SourceBullet[],
  mine: SourceBullet[],
  warnings: string[],
): SourceBullet[] {
  const outlines = {
    base: sourceOutline(base, false),
    current: sourceOutline(current, false),
    mine: sourceOutline(mine, true),
  }
  const kept = mergeSourceBlocks(outlines.base, outlines.current, outlines.mine, warnings)
  const parentOf = mergeSourceParents(outlines, kept, warnings)
  const merged: SourceBullet[] = []
  const emit = (parent: string | null, depth: number): void => {
    for (const key of mergeSourceOrder(outlines, parent, parentOf, warnings)) {
      const block = kept.get(key) as MergedBlock
      if (block.fork !== null) merged.push({ content: block.fork, depth, anchor: null })
      merged.push({ content: block.content, depth, anchor: block.anchor })
      emit(key, depth + 1)
    }
  }
  emit(null, 0)
  return merged
}

/**
 * Every refusal `apply_page_source` makes, checked before anything is written:
 * a stale base unless `merge` folds the page's changes into the buffer
 * (`force` never skips it: it overrides a foreign anchor, not a stale base), a
 * page that does not read back as its own source, an anchor named twice, an
 * anchor that is not a block of this page unless `force` forks it as a new
 * block, and a delete that would take a nested page with it. Returns the
 * buffer's bullets, the page's text per anchor as it reads back, the rendered
 * ids the buffer left out and the warnings.
 */
function readSourceEdit(
  pageId: string,
  source: string,
  baseSource: string,
  flags: { force: boolean; merge: boolean },
): {
  t1: SourceBullet[]
  before: Map<string | null, string>
  absent: string[]
  warnings: string[]
} {
  const current = renderPageSource(pageId)
  const stale = current.source !== baseSource
  if (stale && !flags.merge) {
    throw appErrorRejection({
      kind: 'validation',
      code: 'RequiresRefresh',
      message: `page '${pageId}' changed since its source was loaded`,
    })
  }
  const t0 = parseSourceBuffer(current.source)
  if (t0.length !== current.ids.length || t0.some((b, i) => b.anchor !== current.ids[i])) {
    throw validationRejection(`page '${pageId}' does not read back as its own source`)
  }
  const before = new Map(t0.map((b) => [b.anchor, b.content]))
  const typed = parseSourceBuffer(source)
  const seen = new Set<string>()
  for (const { anchor } of typed) {
    if (anchor === null) continue
    if (seen.has(anchor)) throw validationRejection(`^${anchor} appears more than once`)
    seen.add(anchor)
  }
  // Against the source the edit started from and before the merge, as
  // `read_buffer` heals, so the merge reads a healed bullet as its block.
  const loaded = stale ? parseSourceBuffer(baseSource) : t0
  const loadedIds = new Set(loaded.flatMap(({ anchor }) => (anchor === null ? [] : [anchor])))
  healMovedAnchors(typed, loadedIds, seen)
  const warnings: string[] = []
  const t1 = stale ? mergeSourceBuffer(loaded, t0, typed, warnings) : typed
  const anchors = new Set(t1.flatMap(({ anchor }) => (anchor === null ? [] : [anchor])))
  for (const bullet of t1) {
    if (bullet.anchor === null || before.has(bullet.anchor)) continue
    if (!flags.force) throw validationRejection(`^${bullet.anchor} is not a block of this page`)
    warnings.push(`^${bullet.anchor} no longer on this page; saved as a new block`)
    bullet.anchor = null
  }
  const absent = current.ids.filter((id) => !anchors.has(id))
  const absentSet = new Set(absent)
  for (const row of blocks.values()) {
    if (row['block_type'] !== 'page' || row['deleted_at']) continue
    if (absentSet.has(row['parent_id'] as string)) {
      throw validationRejection(`deleting its parent would delete the page '${String(row['id'])}'`)
    }
  }
  return { t1, before, absent, warnings }
}

/**
 * Put every bullet of `t1` under the parent its indentation names, parent by
 * parent in pre-order from the page. A bullet whose block is already under
 * that parent and in the longest in-order run stays; every other one is moved
 * (or created) right after the bullet before it, so hidden children keep their
 * places. Returns the refs of the ops it appended.
 */
function placeSourceBullets(
  pageId: string,
  t1: SourceBullet[],
  report: { created: number; moved: number },
): OpRefs {
  const childrenOf = new Map<SourceBullet | null, SourceBullet[]>()
  const open: SourceBullet[] = []
  for (const bullet of t1) {
    while ((open.at(-1)?.depth ?? -1) >= bullet.depth) open.pop()
    const parent = open.at(-1) ?? null
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), bullet])
    open.push(bullet)
  }
  const opRefs: OpRefs = []
  const place = (parentId: string, list: SourceBullet[]): void => {
    const rank = new Map(liveChildren(parentId).map((row, i) => [row['id'] as string, i]))
    const kept = longestInOrderRun(
      list.flatMap(({ anchor }) => (anchor !== null && rank.has(anchor) ? [anchor] : [])),
      rank,
    )
    let prev: string | null = null
    const ids: string[] = []
    for (const bullet of list) {
      let id = bullet.anchor
      if (id === null || !kept.has(id)) {
        const others = liveChildren(parentId).filter((row) => row['id'] !== id)
        const index = prev === null ? 0 : others.findIndex((row) => row['id'] === prev) + 1
        if (id === null) {
          const row = blocksHandlers.create_block({
            blockType: 'content',
            content: bullet.content,
            parentId,
            index,
          })
          id = row.id
          opRefs.push(...row.op_refs)
          report.created += 1
        } else {
          const moved = blocksHandlers.move_block({
            blockId: id,
            newParentId: parentId,
            newIndex: index,
          })
          opRefs.push(...moved.op_refs)
          report.moved += 1
        }
      }
      ids.push(id)
      prev = id
    }
    list.forEach((bullet, i) => place(ids[i] as string, childrenOf.get(bullet) ?? []))
  }
  place(pageId, childrenOf.get(null) ?? [])
  return opRefs
}

export const pagesHandlers = {
  // Indexed lookup for a single date-formatted journal page in
  // the active space. Real backend implementation: a SELECT on
  // `idx_blocks_journal_date` with a `space` ref-property subquery.
  get_journal_page_by_date: (args) => {
    const a = args as Record<string, unknown>
    const date = a['date'] as string
    // b1 — IPC arg is now `scope: SpaceScope`. Recover the active space
    // id; a `global` scope yields `null`, which the loop treats as a
    // no-match filter (the backend rejects Global via `require_active`).
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    for (const b of blocks.values()) {
      if (b['block_type'] !== 'page') continue
      if (b['deleted_at']) continue
      if (b['content'] !== date) continue
      const blockProps = properties.get(b['id'] as string)
      const spaceProp = blockProps?.get('space')
      if (spaceProp?.['value_ref'] !== spaceId) continue
      return b
    }
    return null
  },

  // Follow-up: list date-formatted journal pages in the active
  // space whose date falls in `[startDate, endDate]`. The real backend
  // uses the `idx_blocks_journal_date` partial index plus a content
  // range predicate so this is O(visible-days).
  list_journal_pages_in_range: (args) => {
    const a = args as Record<string, unknown>
    const startDate = a['startDate'] as string
    const endDate = a['endDate'] as string
    // b1 — `scope: SpaceScope`. `global` → null → no-match filter.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const datePattern = /^\d{4}-\d{2}-\d{2}$/
    const items: Record<string, unknown>[] = []
    for (const b of blocks.values()) {
      if (b['block_type'] !== 'page') continue
      if (b['deleted_at']) continue
      const content = b['content'] as string | null
      if (!content || !datePattern.test(content)) continue
      if (content < startDate || content > endDate) continue
      const blockProps = properties.get(b['id'] as string)
      const spaceProp = blockProps?.get('space')
      if (spaceProp?.['value_ref'] !== spaceId) continue
      items.push(b)
    }
    // `datePattern` admits only `NNNN-NN-NN`, so every compare resolves on a
    // digit pair — where ICU and SQLite's BINARY agree and `localeCompare` is safe.
    items.sort((x, y) =>
      ((x['content'] as string) ?? '').localeCompare((y['content'] as string) ?? ''),
    )
    return items
  },

  // Every page in the active space as `{ id, content }`.  No pagination,
  // no clamp — bounded by the space's intrinsic page count.  Backs
  // `exportGraphAsZip` and graph rendering.
  //
  // `tagIds`, when non-empty, restricts the result to pages carrying at
  // least one of those tags via the direct `block_tags` table (mock
  // models direct tags only — same surface as the real backend's
  // direct-tag filter; inherited tags intentionally not modelled here).
  list_all_pages_in_space: (args) => {
    const a = args as Record<string, unknown>
    // b1 — `scope: SpaceScope`. `global` → null → no-match filter.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const rawTagIds = a['tagIds'] as string[] | null | undefined
    const tagFilter = rawTagIds && rawTagIds.length > 0 ? new Set(rawTagIds) : null
    const items: Array<{ id: string; content: string | null }> = []
    for (const b of blocks.values()) {
      if (b['block_type'] !== 'page') continue
      if (b['deleted_at']) continue
      const blockProps = properties.get(b['id'] as string)
      const spaceProp = blockProps?.get('space')
      if (spaceProp?.['value_ref'] !== spaceId) continue
      if (tagFilter) {
        const tagsForBlock = blockTags.get(b['id'] as string)
        if (!tagsForBlock) continue
        let hit = false
        for (const t of tagsForBlock) {
          if (tagFilter.has(t)) {
            hit = true
            break
          }
        }
        if (!hit) continue
      }
      items.push({ id: b['id'] as string, content: (b['content'] as string | null) ?? null })
    }
    // `ORDER BY COALESCE(b.content, '') COLLATE NOCASE ASC, b.id ASC`
    // (`src-tauri/src/commands/pages/listing.rs`) — NOCASE folds ASCII only and
    // the tiebreak is plain BINARY.
    items.sort(
      (x, y) => compareNocase(x.content ?? '', y.content ?? '') || compareUtf8Bytes(x.id, y.id),
    )
    return items
  },

  // Every active descendant under `rootBlockId` (one SELECT via the
  // materializer-maintained `page_id` index in production). Replaces
  // the FE-side recursive `listBlocks` walk.
  load_page_subtree: (args) => {
    const a = args as Record<string, unknown>
    const rootBlockId = a['rootBlockId'] as string
    // b1 — `scope: SpaceScope`. `global` → null (backend rejects Global
    // via `require_active`); the membership check below then throws.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    // Space-membership check — mirrors the backend.
    const rootProps = properties.get(rootBlockId)
    const rootSpace = rootProps?.get('space')
    if (rootSpace?.['value_ref'] !== spaceId) {
      // #2463 / #2810 — mirrors `load_page_subtree_inner`'s `Validation`
      // rejection (`src-tauri/src/commands/pages/listing.rs`), not
      // `not_found`; carries the structured `PageNotInSpace` code the
      // frontend's `page-blocks.ts` `load()` heal keys on.
      throw appErrorRejection({
        kind: 'validation',
        code: 'PageNotInSpace',
        message: `block '${rootBlockId}' not in current space '${spaceId}'`,
      })
    }
    const items: Record<string, unknown>[] = []
    for (const b of blocks.values()) {
      if (b['id'] === rootBlockId) continue
      if (b['deleted_at']) continue
      if (b['page_id'] !== rootBlockId) continue
      items.push(b)
    }
    items.sort((x, y) => {
      const px = (x['position'] as number | null) ?? Number.MAX_SAFE_INTEGER
      const py = (y['position'] as number | null) ?? Number.MAX_SAFE_INTEGER
      if (px !== py) return px - py
      return (x['id'] as string).localeCompare(y['id'] as string)
    })
    // #1258 — backend returns `{ blocks, truncated, total }` (see
    // `PageSubtree`). The mock never exceeds the 10k cap, so `truncated`
    // is always false and `total === items.length`.
    return { blocks: items, truncated: false, total: items.length }
  },

  // Paginated page list with per-page metadata columns.
  // Mock parity with `list_pages_with_metadata_inner`: returns the same
  // shape as the backend (BlockRow columns + last_modified_at +
  // inbound_link_count + child_block_count + has_property_flags), sorts
  // by the requested mode, and cursor-paginates using the same keyset
  // shape (cursor.deleted_at = last sort-key string, cursor.seq = last
  // sort-key i64, cursor.id = tiebreaker).
  list_pages_with_metadata: (args) => {
    const a = args as Record<string, unknown>
    const filter = (a['filter'] as Record<string, unknown> | undefined) ?? {}
    const spaceId = filter['spaceId'] as string
    const sort = (filter['sort'] as string | undefined) ?? 'alphabetical'
    const cursor = a['cursor'] as string | null
    const limit = listPagesWithMetadataLimit(a['limit'])

    // Block-link edges derived from `[[ULID]]` tokens (mock stand-in for the
    // backend's `block_links` table) so the link facets and `MostLinked` sort
    // reflect the seed's real topology.
    const edges = deriveLinkEdges(blocks)

    // Build the metadata-rich row for every page in the space.
    const rows: PageMetaRow[] = []
    for (const b of blocks.values()) {
      if (b['block_type'] !== 'page' || b['deleted_at']) continue
      if (properties.get(b['id'] as string)?.get('space')?.['value_ref'] !== spaceId) continue
      const descendants = Array.from(blocks.values()).filter(
        (d) => d['page_id'] === b['id'] && !d['deleted_at'] && d['id'] !== b['id'],
      )
      rows.push(buildPageMetaRow(b, descendants, edges))
    }

    // Phase 3 — AND-compose the requested filter primitives, then sort.
    const filters = (filter['filters'] as Array<Record<string, unknown>> | undefined) ?? []
    const matched = rows.filter((r) => filters.every((f) => metaRowMatchesFilter(r, f)))
    matched.sort((x, y) => compareMetaRows(x, y, sort))

    // Cursor: skip rows up to AND INCLUDING the cursor's anchor.
    let startIdx = 0
    if (cursor) {
      let decoded: Record<string, unknown> | null = null
      try {
        // `base64UrlToUtf8`, not `atob`: the inverse of `encodeNextCursor`'s
        // UTF-8 base64url encoding (#3888). A bare `atob` reads the UTF-8
        // bytes of a non-ASCII title back as Latin-1 code units, so the
        // `alphabetical` cursor round-trip would mojibake. It also still
        // accepts standard-alphabet `btoa` cursors (standard base64 never
        // emits `-`/`_`), which is what keeps hand-rolled stale-cursor
        // fixtures decoding into the discriminator-mismatch path.
        decoded = JSON.parse(base64UrlToUtf8(cursor)) as Record<string, unknown>
      } catch {
        // Malformed cursor: start from the top (mirrors a cursorless fetch).
        decoded = null
      }
      if (decoded) {
        // Cross-sort cursor rejection — mirror the backend's
        // `validate_pages_metadata_cursor`: a cursor minted under one sort
        // carries that sort's `position` discriminator; reusing it after a
        // sort change is rejected with a `Validation` error carrying the
        // structured `RequiresRefresh` code (#2251) the frontend's
        // `withCursorRecovery` recognises (drop cursor → refetch page 1).
        const cursorDisc = decoded['position'] as number | undefined
        if (cursorDisc !== sortDiscriminator(sort)) {
          throw appErrorRejection({
            kind: 'validation',
            code: 'RequiresRefresh',
            message: `cursor sort mismatch (expected ${sort})`,
          })
        }
        const idx = matched.findIndex((r) => r.id === (decoded['id'] as string))
        if (idx >= 0) startIdx = idx + 1
      }
    }
    const slice = matched.slice(startIdx, startIdx + limit + 1)
    const hasMore = slice.length > limit
    const items = hasMore ? slice.slice(0, limit) : slice
    const last = items.at(-1)
    const nextCursor = hasMore && last ? encodeNextCursor(last, sort) : null
    // (null-retention) — mirror the backend: the `total_count`
    // COUNT runs ONLY on the first page (`cursor == null`). The filtered-set
    // total does not change as the user pages with the same filters, so
    // recomputing it on every cursor page is wasted work. Subsequent (cursor)
    // pages return `total_count: null`; the frontend (`PageBrowser`'s
    // `displayTotalCount`) retains the first page's value. Returning the full
    // filtered-set size (not the page slice) on page 1 keeps the count chip
    // and e2e count assertions reflecting the active filters.
    const totalCount = cursor ? null : matched.length
    return { items, next_cursor: nextCursor, has_more: hasMore, total_count: totalCount }
  },

  // Every page in the space whose `template` property is set to 'true'.
  // No pagination, no clamp; the graph view uses this to flag templates.
  list_template_page_ids_in_space: (args) => {
    const a = args as Record<string, unknown>
    // b1 — `scope: SpaceScope`. `global` → null → no-match filter.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const ids: string[] = []
    for (const b of blocks.values()) {
      if (b['block_type'] !== 'page') continue
      if (b['deleted_at']) continue
      const blockProps = properties.get(b['id'] as string)
      if (!blockProps) continue
      const spaceProp = blockProps.get('space')
      if (spaceProp?.['value_ref'] !== spaceId) continue
      const tplProp = blockProps.get('template')
      if (tplProp?.['value_text'] !== 'true') continue
      ids.push(b['id'] as string)
    }
    return ids
  },

  list_undated_tasks: (args) => {
    // Honour `scope: SpaceScope` (mirrors
    // `list_undated_tasks_inner`).
    const a = (args ?? {}) as Record<string, unknown>
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const items = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
      if (b['todo_state'] === null) return false
      if (b['due_date'] !== null) return false
      if (b['scheduled_date'] !== null) return false
      if (spaceId !== null) {
        const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
        const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
        if (ownerSpace !== spaceId) return false
      }
      return true
    })
    return { items, next_cursor: null, has_more: false, total_count: null }
  },

  // Every space is a block carrying `is_space='true'` — the canonical
  // "Personal" space included, which `seedBlocks` lays down as an ordinary
  // page block so the space store hydrates and `currentSpaceId` is non-null
  // for the page-creation flows (Ctrl+N, the PageBrowser input, the `[[`
  // picker) guarded by `if (!isReady || currentSpaceId == null) return` in
  // `App.tsx`.
  //
  // #5057 — "Personal" used to be PREPENDED here as a literal row no block
  // backed, so the mock listed one space the backend could not and the two
  // stacks' `list_spaces` differed by that artefact alone. Projecting only
  // block-backed spaces is what lets `spaces_lifecycle.json` pin this
  // command.
  //
  // `ORDER BY COALESCE(content,'') ASC, id ASC` (`list_spaces_inner`), and
  // `SpaceSwitcher`'s `Ctrl+1`..`Ctrl+9` hotkeys index into this order, so a
  // wrong collation here picks a different space in dev and E2E than in the app.
  list_spaces: () => {
    const rows = [...blocks.values()]
      .filter(
        (b) =>
          !b['deleted_at'] &&
          properties.get(b['id'] as string)?.get('is_space')?.['value_text'] === 'true',
      )
      .map((b) => ({
        id: b['id'] as string,
        name: (b['content'] as string | null) ?? '',
        accent_color:
          (properties.get(b['id'] as string)?.get('accent_color')?.['value_text'] as
            | string
            | null
            | undefined) ?? null,
      }))
    rows.sort((x, y) => compareUtf8Bytes(x.name, y.name) || compareUtf8Bytes(x.id, y.id))
    return rows
  },

  // Phase 2 atomic page-creation IPC. Accepts `parentId` (null for a
  // top-level page), `content`, and `spaceId`. Returns the new page's ULID
  // as a plain string — `bindings.ts` documents this departure from the
  // BlockRow shape used by `create_block`.
  //
  // The real backend wraps both the CreateBlock and
  // SetProperty(space) ops in a single transaction; the mock mirrors
  // that here so journal-page lookups (`get_journal_page_by_date`,
  // `list_journal_pages_in_range`) find newly-created pages by their
  // active space.
  create_page_in_space: (args) => {
    const a = args as Record<string, unknown>
    const parentId = (a['parentId'] as string | null) ?? null
    const spaceId = (a['spaceId'] as string | null) ?? null
    const content = (a['content'] as string) ?? null
    // #4723 — a title is unique among live pages of one space: an existing
    // title resolves to that page (no row, no op), as the backend does.
    const existing = findLivePageByTitle(content, spaceId)
    if (existing !== null) return existing
    const id = fakeId()
    const position = nextDenseRank(parentId, spaceId)
    const row = {
      id,
      block_type: 'page',
      content,
      parent_id: parentId,
      page_id: id,
      position,
      deleted_at: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
      // #3081 — the `blocks.space_id` column, which the alias readers below
      // scope on; the `space` property stays for the handlers that read it.
      space_id: spaceId,
    }
    blocks.set(id, row)
    if (spaceId) {
      if (!properties.has(id)) properties.set(id, new Map())
      properties.get(id)?.set('space', {
        block_id: id,
        key: 'space',
        value_text: null,
        value_num: null,
        value_date: null,
        value_ref: spaceId,
        value_bool: null,
      })
    }
    pushOp('create_block', {
      block_id: id,
      content: row.content,
      parent_id: parentId,
      block_type: 'page',
      position,
    })
    // #5057 — the backend sets the page's space through `set_property` inside
    // the SAME transaction, so its op log carries two ops, not one. The mock
    // appended only the `create_block` until a conformance fixture compared
    // the two digests.
    if (spaceId) pushOp('set_property', { block_id: id, key: 'space', from_value: null })
    return id
  },

  // Atomic space-creation IPC. Accepts `name` and optional
  // `accentColor`. Returns the new space's ULID as a plain string.
  // Mirrors `create_page_in_space` but produces a top-level page block
  // marked with `is_space="true"` so `list_spaces` picks it up.
  create_space: (args) => {
    const a = args as Record<string, unknown>
    const id = fakeId()
    const row = {
      id,
      block_type: 'page',
      content: (a['name'] as string) ?? null,
      parent_id: null,
      page_id: id,
      // A space is not a member of itself, so it ranks in its OWN group, which
      // a freshly minted id cannot already have a member of — hence 1. This was
      // hardcoded `0`, a rank no backend row carries.
      position: 1,
      deleted_at: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
    }
    blocks.set(id, row)
    pushOp('create_block', {
      block_id: id,
      content: row.content,
      parent_id: null,
      block_type: 'page',
      position: row.position,
    })
    pushOp('set_property', {
      block_id: id,
      key: 'is_space',
      value_text: 'true',
      value_number: null,
      value_date: null,
      value_ref: null,
    })
    // #2684 — mirror the op-log write into the queryable `properties` map
    // (the pattern every other `set_property`-style handler in this file
    // follows, e.g. `create_page_in_space`'s `space` write above). Before
    // this fix `is_space`/`accent_color` only ever reached the op log, so
    // `list_spaces`'s scan (which reads `properties`, not `opLog`) could
    // never discover a space created via this handler.
    if (!properties.has(id)) properties.set(id, new Map())
    properties.get(id)?.set('is_space', {
      block_id: id,
      key: 'is_space',
      value_text: 'true',
      value_num: null,
      value_date: null,
      value_ref: null,
      value_bool: null,
    })
    const accentColor = a['accentColor'] as string | null | undefined
    if (accentColor != null) {
      pushOp('set_property', {
        block_id: id,
        key: 'accent_color',
        value_text: accentColor,
        value_number: null,
        value_date: null,
        value_ref: null,
      })
      properties.get(id)?.set('accent_color', {
        block_id: id,
        key: 'accent_color',
        value_text: accentColor,
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      })
    }
    return id
  },

  set_page_aliases: (args) => {
    const a = args as Record<string, unknown>
    const pid = a['pageId'] as string
    const page = blocks.get(pid)
    if (!page || page['block_type'] !== 'page' || page['deleted_at']) {
      // `set_page_aliases_inner` probes for a live page block inside its
      // `BEGIN IMMEDIATE` and answers `NotFound` (#661).
      throw notFoundRejection('page not found')
    }
    // `page_aliases.alias` is UNIQUE COLLATE NOCASE across ALL pages and the
    // write is `INSERT OR IGNORE`, so an alias another page already holds is
    // skipped SILENTLY and left out of the returned list. This page's own rows
    // are excluded because the backend DELETEs them first, which is also why
    // re-listing an alias the page already had is not a self-conflict.
    const taken = new Set<string>()
    for (const [owner, held] of pageAliases) {
      if (owner === pid) continue
      for (const alias of held) taken.add(foldAsciiUppercase(alias))
    }
    const kept: string[] = []
    for (const raw of a['aliases'] as string[]) {
      // Trimmed, and an entry that trims to nothing is skipped — so neither
      // reaches the table nor the answer.
      const alias = raw.trim()
      if (alias === '' || taken.has(foldAsciiUppercase(alias))) continue
      taken.add(foldAsciiUppercase(alias))
      kept.push(alias)
    }
    pageAliases.set(pid, kept)
    return kept
  },

  get_page_aliases: (args) => {
    const a = args as Record<string, unknown>
    const pid = a['pageId'] as string
    // `ORDER BY alias` (NOCASE), not insertion order.
    return (pageAliases.get(pid) ?? []).toSorted(compareNocase)
  },

  resolve_page_by_alias: (args) => {
    const a = args as Record<string, unknown>
    const alias = foldAsciiUppercase(a['alias'] as string)
    // Backend now takes `scope: SpaceScope`. Mirror
    // the `list_page_aliases_by_prefix` mock (sibling below) so an
    // alias pointing at a foreign-space page does not surface when the
    // caller is scoped to the active space. Global keeps the
    // cross-space lookup so the MCP / agent surfaces don't regress.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    for (const [pid, aliases] of pageAliases.entries()) {
      if (aliases.some((al) => foldAsciiUppercase(al) === alias)) {
        const page = blocks.get(pid)
        if (!page) continue
        // `b.deleted_at IS NULL`: a soft-deleted page keeps its alias rows
        // (only a purge cascades them) but stops resolving.
        if (page['deleted_at']) continue
        // `b.space_id = ?`, the #533 column — not the `space` property row
        // migrations 0087/0088 retired (#3081).
        if (spaceId !== null && page['space_id'] !== spaceId) continue
        return [pid, (page['content'] as string) ?? null]
      }
    }
    return null
  },

  // Substring alias autocomplete used by the [[ picker. The IPC name
  // (`prefix`) is historical — matching is now case-insensitive
  // substring (`LIKE '%q%'`) so aliases behave like FTS-backed page
  // titles. Returns `[page_id, alias, title]` rows ordered
  // shortest-alias first (then alphabetical), capped at `limit`
  // (default 50). When the IPC arg's `scope` is `{ kind: 'active',
  // space_id }`, restricts matches to aliases pointing at pages whose
  // `blocks.space_id` column equals the wrapped ULID. Mirrors the backend's
  // `list_page_aliases_by_prefix_inner` shape.
  list_page_aliases_by_prefix: (args) => {
    const a = args as Record<string, unknown>
    const query = foldAsciiUppercase((a['prefix'] as string) ?? '')
    const limit = (a['limit'] as number | null) ?? 50
    // Phase 3 — IPC arg shape: `scope: SpaceScope`. Recover the
    // legacy `spaceId | null` shape for the active-space-scoping branch.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null

    const rows: Array<[string, string, string | null]> = []
    for (const [pid, aliases] of pageAliases.entries()) {
      const page = blocks.get(pid)
      if (!page) continue
      if (page['deleted_at']) continue
      // `b.space_id = ?`, the #533 column — not the `space` property row
      // migrations 0087/0088 retired (#3081).
      if (spaceId !== null && page['space_id'] !== spaceId) continue
      const title = (page['content'] as string | null) ?? null
      for (const alias of aliases) {
        if (foldAsciiUppercase(alias).includes(query)) {
          rows.push([pid, alias, title])
        }
      }
    }
    // `ORDER BY length(pa.alias), pa.alias` — the alias column is NOCASE, and
    // SQLite's `length()` counts CHARACTERS where `String.length` counts UTF-16
    // units, so an astral character would otherwise measure one longer.
    rows.sort(
      (x, y) => Array.from(x[1]).length - Array.from(y[1]).length || compareNocase(x[1], y[1]),
    )
    return rows.slice(0, limit)
  },

  // ---------------------------------------------------------------------------
  // Markdown export
  // ---------------------------------------------------------------------------

  export_page_markdown: (args) => {
    const a = args as Record<string, unknown>
    const pid = a['pageId'] as string
    const page = blocks.get(pid)
    if (!page) throw notFoundRejection(`page '${pid}' not found`)
    const children = [...blocks.values()]
      .filter((b) => b['parent_id'] === pid && !(b['deleted_at'] as string | null))
      .toSorted((x, y) => ((x['position'] as number) ?? 0) - ((y['position'] as number) ?? 0))
    let md = `# ${(page['content'] as string) ?? 'Untitled'}\n\n`
    for (const child of children) {
      md += `- ${(child['content'] as string) ?? ''}\n`
    }
    return md
  },

  get_page_source: (args) =>
    renderPageSource((args as Record<string, unknown>)['pageId'] as string).source,

  // #5140 Phase 4a — save the page edited as its source buffer: moves and
  // creates first, then edits, then deletes, so a child kept out of a deleted
  // block has moved before the delete cascades. The buffer is read by
  // `parseSourceBuffer`, so the backend's list markers, task checkboxes,
  // property lines and names are not modelled (`properties_*` stay 0,
  // `names_created` empty), nor are its op cap and depth limit; tests must not
  // rely on the mock for them. Phase 5: with `merge`, a stale buffer is saved
  // with the page's changes folded in (`mergeSourceBuffer`).
  apply_page_source: (args) => {
    const a = args as Record<string, unknown>
    const pageId = a['pageId'] as string
    const edit = readSourceEdit(pageId, a['source'] as string, a['baseSource'] as string, {
      force: a['force'] === true,
      merge: a['merge'] === true,
    })
    const report = { created: 0, edited: 0, moved: 0, deleted: 0 }
    const opRefs = placeSourceBullets(pageId, edit.t1, report)
    for (const { anchor, content } of edit.t1) {
      if (anchor === null || content === edit.before.get(anchor)) continue
      if (content === blocks.get(anchor)?.['content']) continue
      opRefs.push(...blocksHandlers.edit_block({ blockId: anchor, toText: content }).op_refs)
      report.edited += 1
    }
    const absentSet = new Set(edit.absent)
    for (const id of edit.absent) {
      if (absentSet.has(blocks.get(id)?.['parent_id'] as string)) continue
      const response = blocksHandlers.delete_block({ blockId: id })
      opRefs.push(...response.op_refs)
      report.deleted += response.descendants_affected
    }
    return {
      op_refs: opRefs,
      ...report,
      properties_set: 0,
      properties_deleted: 0,
      names_created: [],
      warnings: edit.warnings,
    }
  },

  // DELIBERATE APPROXIMATION of `get_blocks_source` (#5140 Phase 3b), the
  // clipboard copy: each root as `- first line`, its further lines indented
  // under the bullet, and with `withChildren` its live content descendants
  // two columns deeper per level. No anchors, list markers, task checkboxes,
  // property lines or humanised names — the Rust tests own that grammar, as
  // for `get_page_source` above. Like the backend, the page is the first live
  // content id's, other ids are skipped, and an id under a selected ancestor
  // travels with that ancestor instead of being a root of its own.
  get_blocks_source: (args) => {
    const a = args as Record<string, unknown>
    const ids = (a['blockIds'] as string[] | undefined) ?? []
    const withChildren = a['withChildren'] === true
    const liveContent = (id: string): Record<string, unknown> | null => {
      const row = blocks.get(id)
      return row && !row['deleted_at'] && row['block_type'] === 'content' ? row : null
    }
    const first = ids.map(liveContent).find((row) => row != null)
    if (!first) return ''
    const pageId = first['page_id']
    const selected = new Set(ids.filter((id) => liveContent(id)?.['page_id'] === pageId))
    let md = ''
    const renderBlock = (row: Record<string, unknown>, depth: number): void => {
      const [head, ...rest] = ((row['content'] as string | null) ?? '').split('\n')
      md += `${'  '.repeat(depth)}- ${head}\n`
      for (const line of rest) md += line === '' ? '\n' : `${'  '.repeat(depth + 1)}${line}\n`
      if (!withChildren) return
      for (const child of liveChildren(row['id'] as string)) {
        if (child['block_type'] === 'content') renderBlock(child, depth + 1)
      }
    }
    const findRoots = (parentId: string): void => {
      for (const child of liveChildren(parentId)) {
        if (selected.has(child['id'] as string)) renderBlock(child, 0)
        else findRoots(child['id'] as string)
      }
    }
    findRoots(pageId as string)
    return md
  },

  // ---------------------------------------------------------------------------
  // Markdown import (#660)
  // ---------------------------------------------------------------------------

  // DELIBERATE APPROXIMATION of the Rust importer (#1919). The real import
  // contract lives in `src-tauri/src/import.rs` (`parse_logseq_markdown`) and
  // `src-tauri/src/commands/pages/markdown.rs` (`import_markdown_with_progress`
  // / `folder_path_to_namespace_title`). This handler does NOT reimplement that
  // parser — it deliberately models a faithful *subset* of the backend so the
  // dev-preview UI (progress bar, warnings panel, "N properties" branch) is
  // exercised, while never *accepting more structure than the backend does*.
  //
  // It intentionally aligns with the backend on the two things tests can assert:
  //   - Title: derived from the filename/folder path the same way the backend
  //     does (strip `.md`, normalise `\`→`/`, drop empty segments, rejoin with
  //     `/`), falling back to "Imported Page". A leading `# heading` is NOT a
  //     title source (the backend never reads one — import.rs treats `# heading`
  //     as ordinary content).
  //   - Block bullets: ONLY a `- ` prefix marks a bullet, matching
  //     import.rs `strip_prefix("- ")`. `*`, `+`, and `1.` markers are kept as
  //     literal content (the backend does not recognise them).
  //
  // It intentionally does NOT model (and tests MUST NOT rely on the mock for
  // any of these — the Rust tests own the import contract):
  //   - Frontmatter / inline `key:: value` properties beyond a raw COUNT
  //     (`properties_set`); no property values are stamped onto blocks.
  //   - Wiki-link (`[[...]]`) resolution.
  //   - `((block-ref))` stripping.
  //   - Indentation → depth nesting (all content blocks are emitted flat).
  //   - `#tag` and attachment handling (kept as literal text).
  //
  // WARNING: mock-backed frontend tests give NO assurance about import-contract
  // fidelity. Validate import semantics against the Rust tests, not this mock.
  import_markdown: (args) => {
    const a = args as Record<string, unknown>
    const content = (a['content'] as string) ?? ''
    const filename = (a['filename'] as string | null) ?? null
    // Backend now requires `space_id`. Mirror the
    // backend behaviour: stamp `space = ?spaceId` on the created page
    // so `tauri-mock-parity` and downstream space-scoped read mocks
    // see the imported page in the active space. The backend rejects
    // empty / missing values with `AppError::Validation`; the mock is
    // permissive about the value (skips the stamp when empty) so older
    // mock fixtures that pre-date this fix don't break.
    const spaceId = (a['spaceId'] as string | undefined) ?? ''

    // `onProgress` (#128) — the real backend streams per-block progress over a
    // `Channel<ImportProgressUpdate>`. The FE wrapper (`importMarkdown` in
    // `tauri.ts`) ALWAYS passes a `Channel` as the `progress` arg, even when no
    // callback is wired. `mockIPC` forwards args verbatim (no IPC
    // serialization), so `a['progress']` is the live `Channel` instance and its
    // public `onmessage` getter returns the consumer's callback. We drive it
    // directly below so the dev-preview progress bar / aria-live announcements
    // actually fire (the real emission contract: one `started`, one `progress`
    // per block, one `complete` after the "commit"). Best-effort: if the arg is
    // absent or shaped unexpectedly, emission is silently skipped.
    const progress = a['progress'] as { onmessage?: (u: unknown) => void } | undefined
    const emit = (update: unknown): void => {
      try {
        progress?.onmessage?.(update)
      } catch {
        // A faulty consumer callback must not break the mock import.
      }
    }

    // Derive the page title the way the backend does
    // (`folder_path_to_namespace_title`, markdown.rs): strip a trailing `.md`,
    // normalise `\`→`/`, drop empty segments, rejoin with `/`. A leading
    // `# heading` is NOT a title source (import.rs never reads one — it treats
    // the heading line as ordinary content). Fall back to "Imported Page" when
    // nothing usable remains, matching markdown.rs:884.
    const namespaceTitle = (filename ?? '')
      .replace(/\.md$/i, '')
      .replace(/\\/g, '/')
      .split('/')
      .map((seg) => seg.trim())
      .filter((seg) => seg.length > 0)
      .join('/')
    const pageTitle = namespaceTitle.length > 0 ? namespaceTitle : 'Imported Page'
    // The heading line stays in `lines` as ordinary content (no shift),
    // mirroring the backend which never excises a `# heading` line.
    const lines = content.split('\n')

    // Faithful-but-simple property count: the real importer pulls properties
    // from YAML frontmatter and inline `key:: value` lines. We don't reproduce
    // the parser — we just count `key:: value` occurrences so the result panel's
    // "N properties" branch is exercised in dev-preview rather than hardcoded to
    // 0. (Frontmatter and `#tag` parsing are intentionally NOT modelled here.)
    const propertiesSet = lines.filter((line) => /^\s*[^\s:][^:]*::\s+\S/.test(line)).length

    // Create the page block + stamp `space` ref property.
    const pageId = fakeId()
    const pageBlock = makeBlock(pageId, 'page', pageTitle, null, blocks.size)
    blocks.set(pageId, pageBlock)
    if (spaceId) {
      if (!properties.has(pageId)) properties.set(pageId, new Map())
      properties.get(pageId)?.set('space', {
        block_id: pageId,
        key: 'space',
        value_text: null,
        value_num: null,
        value_date: null,
        value_ref: spaceId,
        value_bool: null,
      })
    }

    // Pre-compute the content blocks so we know `blocks_total` before emitting
    // `started` (the real backend reports the parser's count up front so the UI
    // can render a determinate bar from the very first event).
    const contentLines = lines
      .map((line) =>
        line
          // Strip ONLY a leading `- ` bullet marker, matching the backend
          // (import.rs `strip_prefix("- ")`). `*`, `+`, and `1.` markers are
          // NOT recognised by the importer, so they are left as literal content
          // here — the mock must not accept structure the real importer ignores.
          .replace(/^\s*-\s+/, '')
          .trim(),
      )
      .filter((trimmed) => trimmed.length > 0)
    const blocksTotal = contentLines.length

    emit({ kind: 'started', page_title: pageTitle, blocks_total: blocksTotal })

    let blocksCreated = 0
    let position = 0
    for (const trimmed of contentLines) {
      const blockId = fakeId()
      const block = makeBlock(blockId, 'content', trimmed, pageId, position)
      blocks.set(blockId, block)
      blocksCreated++
      position++
      emit({ kind: 'progress', blocks_done: blocksCreated, blocks_total: blocksTotal })
    }

    // Representative non-empty warning so the result panel's warning UI is
    // exercised in dev-preview. Mirrors the shape of a real parse-time
    // diagnostic (#tag fidelity is not implemented; hashtags stay literal text).
    const warnings: string[] = [
      'dev-preview mock: tags (#tag) and attachments are not imported (kept as literal text)',
    ]

    emit({
      kind: 'complete',
      page_title: pageTitle,
      blocks_created: blocksCreated,
      properties_set: propertiesSet,
    })

    return {
      page_title: pageTitle,
      blocks_created: blocksCreated,
      properties_set: propertiesSet,
      warnings,
    }
  },

  // ---------------------------------------------------------------------------
  // Attachment commands (F-7)
  // ---------------------------------------------------------------------------

  // DELIBERATE APPROXIMATION of the Rust bibliography importer (#1454). The
  // real parsing contract (BibTeX field extraction, CSL-JSON mapping,
  // duplicate skipping, per-entry warnings) lives in the backend's
  // `import_bibliography` command — this handler parses NOTHING. It exists so
  // the dev-preview UI (success toast counts, warnings panel, AppError toast)
  // is exercisable in browser mode:
  //   - Entry count is a trivial derivation, not a parse: BibTeX → the number
  //     of `@type{` prefixes; CSL-JSON → `JSON.parse` array length, falling
  //     back to 0 when the JSON is malformed or not an array.
  //   - Each counted entry becomes a placeholder page ("Reference N") stamped
  //     into the target space; no reference properties are modelled beyond
  //     the raw `properties_set` count (one per page, for the space stamp).
  //   - `entries_skipped` is always 0 — duplicate detection is backend-only.
  // WARNING: mock-backed frontend tests give NO assurance about the parsing
  // contract. Validate bibliography semantics against the Rust tests.
  import_bibliography: (args) => {
    const a = args as Record<string, unknown>
    const content = (a['content'] as string) ?? ''
    const format = (a['format'] as string | null) ?? null
    const spaceId = (a['spaceId'] as string | undefined) ?? ''

    // #2463 kind-parity — the backend rejects an empty / unknown space id
    // with `AppError::Validation`, same as `import_markdown`. The mock's
    // known spaces are the canonical hardcoded 'SPACE_PERSONAL' (see
    // `list_spaces` above, which never lives in `blocks`) plus any
    // `create_space`-created block.
    if (spaceId !== 'SPACE_PERSONAL' && !blocks.has(spaceId)) {
      throw validationRejection('space_id does not refer to a live space block')
    }

    // `format: null` = auto-detect. Trivial content sniff mirroring the
    // backend's documented behaviour: BibTeX entries start with `@`,
    // anything else is treated as CSL-JSON.
    const effectiveFormat = format ?? (content.trim().startsWith('@') ? 'bibtex' : 'csl-json')

    let entryCount = 0
    if (effectiveFormat === 'bibtex') {
      entryCount = (content.match(/@[A-Za-z]+\s*\{/g) ?? []).length
    } else {
      try {
        const parsed: unknown = JSON.parse(content)
        entryCount = Array.isArray(parsed) ? parsed.length : 0
      } catch {
        entryCount = 0
      }
    }

    for (let i = 0; i < entryCount; i++) {
      const pageId = fakeId()
      blocks.set(pageId, makeBlock(pageId, 'page', `Reference ${i + 1}`, null, blocks.size))
      if (!properties.has(pageId)) properties.set(pageId, new Map())
      properties.get(pageId)?.set('space', {
        block_id: pageId,
        key: 'space',
        value_text: null,
        value_num: null,
        value_date: null,
        value_ref: spaceId,
        value_bool: null,
      })
    }

    // Representative non-empty warning so the result panel's warnings UI is
    // exercised in dev-preview, mirroring the `import_markdown` mock.
    const warnings: string[] = [
      'dev-preview mock: bibliography entries are not parsed — pages carry placeholder titles and no reference properties',
    ]
    if (entryCount === 0) {
      warnings.push('no bibliography entries detected in the file')
    }

    return {
      pages_created: entryCount,
      entries_skipped: 0,
      properties_set: entryCount,
      warnings,
    }
  },
} satisfies Pick<
  TypedHandlers,
  | 'get_journal_page_by_date'
  | 'list_journal_pages_in_range'
  | 'list_all_pages_in_space'
  | 'load_page_subtree'
  | 'list_pages_with_metadata'
  | 'list_template_page_ids_in_space'
  | 'list_undated_tasks'
  | 'list_spaces'
  | 'create_page_in_space'
  | 'create_space'
  | 'set_page_aliases'
  | 'get_page_aliases'
  | 'resolve_page_by_alias'
  | 'list_page_aliases_by_prefix'
  | 'export_page_markdown'
  | 'get_page_source'
  | 'apply_page_source'
  | 'get_blocks_source'
  | 'import_markdown'
  | 'import_bibliography'
>
