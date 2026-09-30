/**
 * Tauri mock — the name pass of paste, Edit as Markdown and import: the
 * `[[name]]` and `#tag` tokens `scanNameTokens` finds are resolved in one
 * space and written as ids, creating the pages and tags no name there matches.
 * Mirrors `resolve_inbound_page_links` / `resolve_tag_names` in
 * `src-tauri/src/commands/pages/markdown.rs` (#5160 N4):
 *
 *   - a page is the exact title, else the unique case-insensitive title (as
 *     SQLite's `NOCASE` folds, ASCII letters), else the unique alias, else
 *     created; two pages that tie are never guessed: the token stays text and
 *     a warning names it;
 *   - a `[[Page#anchor]]` token is the page titled `Page#anchor` when one
 *     exists (D10), else its page; the block anchors the backend resolves to
 *     `((ULID))` refs are not modelled;
 *   - a `[[Page|label]]` token keeps its label as `[[id|label]]` unless the
 *     label is the page's title (D9);
 *   - a body holding a `|` reads as the first of its readings (whole, then
 *     each prefix before a `|`, longest first) that names a page, else splits
 *     on its first `|`; a reading that ties leaves it text with a warning
 *     (D10);
 *   - a tag is the smallest-id tag of the same normalised name, else created.
 *
 * Created pages come first, in name order, then tags, each with the
 * `create_block` and `set_property` (space) ops the backend appends.
 */

import {
  type LinkReading,
  linkBodyReadings,
  type PageToken,
  scanNameTokens,
} from '@/lib/name-tokens'
import { compareUtf8Bytes, foldAsciiUppercase } from '@/lib/sqlite-collation'
import {
  appendSlot,
  insertAtSlotAndRenumber,
  ownerSpaceOf,
  validationRejection,
} from '@/lib/tauri-mock/handlers/shared'
import { blocks, fakeId, pageAliases, properties, pushOp } from '@/lib/tauri-mock/seed'

type OpRefs = Array<{ device_id: string; seq: number }>
type Row = Record<string, unknown>

export interface ResolvedNames {
  /** `contents`, with each resolved token written as its id. */
  contents: string[]
  /** The pages and tags created, in creation order. */
  created: Row[]
  warnings: string[]
}

type Match = { id: string } | 'ambiguous' | null

/** `agaric_core::tag_norm::normalize_tag_name`: NFC, lowercase, NFC. */
const normalizeTagName = (name: string): string =>
  name.normalize('NFC').toLowerCase().normalize('NFC')

function inSpace(row: Row, spaceId: string): boolean {
  return row['deleted_at'] == null && (row['space_id'] === spaceId || ownerSpaceOf(row) === spaceId)
}

function livePages(spaceId: string): Row[] {
  return [...blocks.values()]
    .filter((b) => b['block_type'] === 'page' && inSpace(b, spaceId))
    .toSorted((a, b) => compareUtf8Bytes(a['id'] as string, b['id'] as string))
}

const only = (ids: string[]): Match =>
  ids.length === 0 ? null : ids.length === 1 ? { id: ids[0] as string } : 'ambiguous'

/** The title arms of `LinkMatches::find`: the exact title, else the case-folded one. */
function findTitled(name: string, pages: readonly Row[]): Match {
  const folded = foldAsciiUppercase(name)
  const titled = (same: (title: string) => boolean): string[] =>
    pages.filter((p) => same((p['content'] as string | null) ?? '')).map((p) => p['id'] as string)
  return only(titled((t) => t === name)) ?? only(titled((t) => foldAsciiUppercase(t) === folded))
}

/** `LinkMatches::find` over the live pages of the space. */
function findPage(name: string, pages: readonly Row[]): Match {
  const folded = foldAsciiUppercase(name)
  const aliased = pages
    .filter((p) =>
      (pageAliases.get(p['id'] as string) ?? []).some((a) => foldAsciiUppercase(a) === folded),
    )
    .map((p) => p['id'] as string)
  return findTitled(name, pages) ?? only(aliased)
}

/**
 * `LinkMatches::find_name`: the page titled with the whole name, else, when an
 * anchor holding no `|` follows its first `#`, the page its base names.
 */
function findName(name: string, pages: readonly Row[]): Match {
  const hashAt = name.indexOf('#')
  const base = hashAt < 0 ? '' : name.slice(0, hashAt).trim()
  const anchored = base !== '' && !name.slice(hashAt + 1).includes('|')
  return findPage(name, pages) ?? (anchored ? findPage(base, pages) : null)
}

/**
 * `read_link_body`: the first longer reading of the token's body whose name
 * names a page, else its first-`|` split; `null` when a reading ties.
 */
function readLinkBody(token: PageToken, pages: readonly Row[]): LinkReading | null {
  for (const reading of linkBodyReadings(token.body).slice(0, -1)) {
    const match = findName(reading.name, pages)
    if (match === 'ambiguous') return null
    if (match) return reading
  }
  return token.label === undefined ? { name: token.name } : { name: token.name, label: token.label }
}

/**
 * The page an import of a file titled `title` adopts (#5160 D12): the one
 * page of that title, exact or case-folded, when it has no live child; never
 * a page matched by alias (`create_import_page`); `null` otherwise.
 */
export function findEmptyPageTitled(title: string, spaceId: string): string | null {
  const match = findTitled(title, livePages(spaceId))
  if (!match || match === 'ambiguous') return null
  const hasChild = [...blocks.values()].some(
    (b) => b['parent_id'] === match.id && b['deleted_at'] == null,
  )
  return hasChild ? null : match.id
}

/**
 * The block a text value under a `ref` definition names for a block of
 * `spaceId` (#5160 D11), as `read_typed_ref` reads it: `[[Title]]` less its
 * brackets, or the value, is a live block id in the space, else a page title
 * by `LinkMatches::find`. A tie, or no match, is refused.
 */
export function resolveRefValue(value: string, spaceId: string | null): string {
  const trimmed = value.trim()
  const inner = trimmed.startsWith('[[') ? trimmed.slice(2) : ''
  const name = inner.endsWith(']]') ? inner.slice(0, -2).trim() : trimmed
  if (/^[0-9A-Z]{26}$/.test(name)) {
    const row = blocks.get(name)
    if (!row || row['deleted_at'] != null) {
      throw validationRejection(`'${name}' is not the id of a live block`)
    }
    const target = (row['space_id'] as string | null) ?? ownerSpaceOf(row)
    if (spaceId !== null && target !== null && target !== spaceId) {
      throw validationRejection(`'${name}' is a block of another space`)
    }
    return name
  }
  const match = spaceId === null ? null : findPage(name, livePages(spaceId))
  if (match === 'ambiguous') throw validationRejection(`more than one page is titled '${name}'`)
  if (match === null) throw validationRejection(`no page is titled '${name}' in this space`)
  return match.id
}

/** A page or tag created as the backend's `create_block_in_tx` + space stamp. */
function createNamed(
  blockType: 'page' | 'tag',
  content: string,
  spaceId: string,
  opRefs: OpRefs,
): Row {
  const id = fakeId()
  const row: Row = {
    id,
    block_type: blockType,
    content,
    parent_id: null,
    page_id: blockType === 'page' ? id : null,
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    space_id: spaceId,
  }
  blocks.set(id, row)
  insertAtSlotAndRenumber(null, id, appendSlot(null, id))
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
  const create = pushOp('create_block', {
    block_id: id,
    content,
    parent_id: null,
    block_type: blockType,
    position: row['position'],
  })
  const stamp = pushOp('set_property', { block_id: id, key: 'space', from_value: null })
  opRefs.push(
    { device_id: create.device_id, seq: create.seq },
    { device_id: stamp.device_id, seq: stamp.seq },
  )
  return row
}

/** `stored_page_link`: the label is kept unless it is the page's title (#5160 D9). */
function pageRef(id: string, label: string | undefined): string {
  return label && label !== blocks.get(id)?.['content'] ? `[[${id}|${label}]]` : `[[${id}]]`
}

/** Resolve the names `contents` write in `spaceId`, creating what no name matches. */
export function resolveInboundNames(
  contents: readonly string[],
  spaceId: string,
  opRefs: OpRefs,
): ResolvedNames {
  const scanned = contents.map((content) => scanNameTokens(content))
  const sorted = (names: Iterable<string>): string[] =>
    [...new Set(names)].toSorted(compareUtf8Bytes)
  const created: Row[] = []
  const warnings: string[] = []
  const tied = (text: string) =>
    warnings.push(
      `wiki-link '[[${text}]]' matches multiple pages in this space; left as plain text`,
    )
  const pages = livePages(spaceId)
  const pageTokens = new Map<string, PageToken>()
  for (const token of scanned.flat()) {
    if (token.kind === 'page') pageTokens.set(token.body, token)
  }
  const readings = new Map<string, LinkReading>()
  for (const [body, token] of [...pageTokens].toSorted(([a], [b]) => compareUtf8Bytes(a, b))) {
    const reading = readLinkBody(token, pages)
    if (reading === null) tied(body)
    else readings.set(body, reading)
  }
  const pageIds = new Map<string, string>()
  const resolvePage = (title: string): string | null => {
    const match = findPage(title, pages)
    if (match === 'ambiguous') {
      tied(title)
      return null
    }
    if (match) return match.id
    const row = createNamed('page', title, spaceId, opRefs)
    pages.push(row)
    created.push(row)
    return row['id'] as string
  }
  for (const name of sorted([...readings.values()].map((r) => r.name))) {
    const hashAt = name.indexOf('#')
    const base = hashAt < 0 ? name : name.slice(0, hashAt).trim()
    if (base === '') continue
    const whole = hashAt < 0 ? null : findPage(name, pages)
    // A whole anchored title that ties is left as text, never its base.
    if (whole === 'ambiguous') {
      tied(name)
      continue
    }
    const id = whole ? whole.id : resolvePage(base)
    if (id !== null) pageIds.set(name, id)
  }
  const tagIds = new Map<string, string>()
  const tagsByNorm = new Map<string, string>()
  for (const row of [...blocks.values()].toSorted((a, b) =>
    compareUtf8Bytes(a['id'] as string, b['id'] as string),
  )) {
    if (row['block_type'] !== 'tag' || row['content'] == null || !inSpace(row, spaceId)) continue
    const norm = normalizeTagName(row['content'] as string)
    if (!tagsByNorm.has(norm)) tagsByNorm.set(norm, row['id'] as string)
  }
  for (const name of sorted(scanned.flat().flatMap((t) => (t.kind === 'tag' ? [t.name] : [])))) {
    const norm = normalizeTagName(name)
    let id = tagsByNorm.get(norm)
    if (id === undefined) {
      const row = createNamed('tag', name, spaceId, opRefs)
      created.push(row)
      id = row['id'] as string
      tagsByNorm.set(norm, id)
    }
    tagIds.set(name, id)
  }
  const linkRef = (token: PageToken): string | undefined => {
    const reading = readings.get(token.body)
    const id = reading && pageIds.get(reading.name)
    return id === undefined ? undefined : pageRef(id, reading?.label)
  }
  const rewritten = contents.map((content, i) => {
    let out = content
    for (const token of (scanned[i] ?? []).toReversed()) {
      const tagId = token.kind === 'tag' ? tagIds.get(token.name) : undefined
      const ref = token.kind === 'page' ? linkRef(token) : tagId && `#[${tagId}]`
      if (ref === undefined) continue
      out = out.slice(0, token.start) + ref + out.slice(token.end)
    }
    return out
  })
  return { contents: rewritten, created, warnings }
}
