/**
 * Tauri mock — the name pass of paste, Edit as Markdown and import: the
 * `[[name]]` and `#tag` tokens `scanNameTokens` finds are resolved in one
 * space and written as ids, creating the pages and tags no name there matches.
 * Mirrors `resolve_inbound_page_links` / `resolve_tag_names` in
 * `src-tauri/src/commands/pages/markdown_import_links.rs` (#5160 N4):
 *
 *   - a page is the title under `nameKey`, else the alias under it, else
 *     created; where several pages hold the name, the lowest id does
 *     (#6278);
 *   - a `[[Page#anchor]]` token is the page titled `Page#anchor` when one
 *     exists (D10), else its page; the block anchors the backend resolves to
 *     `((ULID))` refs are not modelled;
 *   - a `[[Page|label]]` token keeps its label as `[[id|label]]` unless the
 *     label is the page's title (D9);
 *   - a body holding a `|` reads as the first of its readings (whole, then
 *     each prefix before a `|`, longest first) that names a page, else splits
 *     on its first `|` (D10);
 *   - a tag is the smallest-id tag of the same normalised name, else created.
 *
 * Created pages come first, in name order, then tags, each with the
 * `create_block` and `set_property` (space) ops the backend appends.
 */

import { ULID_RE } from '@/editor/markdown-common'
import {
  dashedTagName,
  type LinkReading,
  linkBodyReadings,
  nameKey,
  normalizeTagName,
  type PageToken,
  scanNameTokens,
} from '@/lib/name-tokens'
import { compareUtf8Bytes } from '@/lib/sqlite-collation'
import {
  appendSlot,
  insertAtSlotAndRenumber,
  ownerSpaceOf,
  validationRejection,
} from '@/lib/tauri-mock/handlers/shared'
import { blocks, fakeId, pageAliases, pushOp } from '@/lib/tauri-mock/seed'

type OpRefs = Array<{ device_id: string; seq: number }>
type Row = Record<string, unknown>

export interface ResolvedNames {
  /** `contents`, with each resolved token written as its id. */
  contents: string[]
  /** The pages and tags created, in creation order. */
  created: Row[]
  /** A warning per tag name respelled (#6278 I4). */
  warnings: string[]
}

function inSpace(row: Row, spaceId: string): boolean {
  return row['deleted_at'] == null && row['space_id'] === spaceId
}

function livePages(spaceId: string): Row[] {
  return [...blocks.values()]
    .filter((b) => b['block_type'] === 'page' && inSpace(b, spaceId))
    .toSorted((a, b) => compareUtf8Bytes(a['id'] as string, b['id'] as string))
}

/** The lowest of `ids`, the one that holds a name several pages share (#6278). */
const lowest = (ids: string[]): string | null => ids.toSorted(compareUtf8Bytes)[0] ?? null

/** `LinkMatches::find`'s title arm: the lowest id of the pages whose `nameKey` is `name`'s. */
function findTitled(name: string, pages: readonly Row[]): string | null {
  const key = nameKey(name)
  return lowest(
    pages
      .filter((p) => nameKey((p['content'] as string | null) ?? '') === key)
      .map((p) => p['id'] as string),
  )
}

/** `LinkMatches::find` over the live pages of the space. */
function findPage(name: string, pages: readonly Row[]): string | null {
  const key = nameKey(name)
  const aliased = pages
    .filter((p) => (pageAliases.get(p['id'] as string) ?? []).some((a) => nameKey(a) === key))
    .map((p) => p['id'] as string)
  return findTitled(name, pages) ?? lowest(aliased)
}

/**
 * `LinkMatches::find_name`: the page titled with the whole name, else, when an
 * anchor holding no `|` follows its first `#`, the page its base names.
 */
function findName(name: string, pages: readonly Row[]): string | null {
  const hashAt = name.indexOf('#')
  const base = hashAt < 0 ? '' : name.slice(0, hashAt).trim()
  const anchored = base !== '' && !name.slice(hashAt + 1).includes('|')
  return findPage(name, pages) ?? (anchored ? findPage(base, pages) : null)
}

/**
 * `read_link_body`: the first longer reading of the token's body whose name
 * names a page, else its first-`|` split.
 */
function readLinkBody(token: PageToken, pages: readonly Row[]): LinkReading {
  const named = linkBodyReadings(token.body)
    .slice(0, -1)
    .find((reading) => findName(reading.name, pages) !== null)
  if (named) return named
  return token.label === undefined ? { name: token.name } : { name: token.name, label: token.label }
}

/**
 * The page an import of a file titled `title` adopts (#5160 D12): the page of
 * that title under `nameKey`, the lowest id where several share it (#6278),
 * when it has no live child; never a page matched by alias
 * (`create_import_page`); `null` otherwise.
 */
export function findEmptyPageTitled(title: string, spaceId: string): string | null {
  const match = findTitled(title, livePages(spaceId))
  if (match === null) return null
  const hasChild = [...blocks.values()].some(
    (b) => b['parent_id'] === match && b['deleted_at'] == null,
  )
  return hasChild ? null : match
}

/**
 * The block a text value under a `ref` definition names for a block of
 * `spaceId` (#5160 D11), as `read_typed_ref` reads it: `[[Title]]` less its
 * brackets, or the value, is a live block id in the space, else a page title
 * by `LinkMatches::find`. No match is refused.
 */
export function resolveRefValue(value: string, spaceId: string | null): string {
  const trimmed = value.trim()
  const inner = trimmed.startsWith('[[') ? trimmed.slice(2) : ''
  const name = inner.endsWith(']]') ? inner.slice(0, -2).trim() : trimmed
  if (ULID_RE.test(name)) {
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
  if (match === null) throw validationRejection(`no page is titled '${name}' in this space`)
  return match
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

/**
 * Each of `names` as the tag of `spaceId` its normalised name names (the
 * smallest id wins), else the tag of its dashed name (#6278 I4), created
 * where there is none. Returns the ids, the tags created in creation order,
 * and a warning per name respelled. Mock twin of `resolve_tag_names` and
 * `inbound_tag_spelling` (`markdown.rs`).
 */
export function resolveTagNames(
  names: readonly string[],
  spaceId: string,
  opRefs: OpRefs,
): { ids: Map<string, string>; created: Row[]; warnings: string[] } {
  const created: Row[] = []
  const tagsByNorm = new Map<string, string>()
  for (const row of [...blocks.values()].toSorted((a, b) =>
    compareUtf8Bytes(a['id'] as string, b['id'] as string),
  )) {
    if (row['block_type'] !== 'tag' || row['content'] == null || !inSpace(row, spaceId)) continue
    const norm = normalizeTagName(row['content'] as string)
    if (!tagsByNorm.has(norm)) tagsByNorm.set(norm, row['id'] as string)
  }
  const ids = new Map<string, string>()
  const warnings: string[] = []
  for (const token of names) {
    const name = tagsByNorm.has(normalizeTagName(token)) ? token : dashedTagName(token)
    if (name !== token) {
      warnings.push(`tag '${token}' was read as '${name}': a tag name holds no whitespace`)
    }
    const norm = normalizeTagName(name)
    let id = tagsByNorm.get(norm)
    if (id === undefined) {
      const row = createNamed('tag', name, spaceId, opRefs)
      created.push(row)
      id = row['id'] as string
      tagsByNorm.set(norm, id)
    }
    ids.set(token, id)
  }
  return { ids, created, warnings }
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
  const pages = livePages(spaceId)
  const pageTokens = new Map<string, PageToken>()
  for (const token of scanned.flat()) {
    if (token.kind === 'page') pageTokens.set(token.body, token)
  }
  const readings = new Map<string, LinkReading>()
  for (const [body, token] of [...pageTokens].toSorted(([a], [b]) => compareUtf8Bytes(a, b))) {
    readings.set(body, readLinkBody(token, pages))
  }
  const pageIds = new Map<string, string>()
  const resolvePage = (title: string): string => {
    const match = findPage(title, pages)
    if (match !== null) return match
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
    pageIds.set(name, whole ?? resolvePage(base))
  }
  const tags = resolveTagNames(
    sorted(scanned.flat().flatMap((t) => (t.kind === 'tag' ? [t.name] : []))),
    spaceId,
    opRefs,
  )
  created.push(...tags.created)
  const tagIds = tags.ids
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
  return { contents: rewritten, created, warnings: tags.warnings }
}
