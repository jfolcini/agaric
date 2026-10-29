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

import {
  closesFence,
  type DocumentBlock,
  documentFenceOpener,
  needsAnchorLineEscape,
  needsBareLineEscape,
  needsBlankLineEscape,
  needsDocumentLineEscape,
  needsTaskMarkerEscape,
  parseDocument,
  writeSourcePropertyValue,
} from '@/editor/source-buffer-document'
import { base64UrlToUtf8 } from '@/lib/base64url'
import type { PageHeading } from '@/lib/bindings'
import {
  INLINE_PROPERTY_RESERVED_KEYS,
  foldPropertyKey,
  isInlinePropertyKey,
} from '@/lib/inline-property-parse'
import { normalizeTagName } from '@/lib/name-tokens'
import { compareNocase, compareUtf8Bytes, foldAsciiUppercase } from '@/lib/sqlite-collation'
import { TASK_STATE_TO_MARKER, type TodoState } from '@/lib/task-states'
import { blocksHandlers, parseOutline } from '@/lib/tauri-mock/handlers/blocks'
import { propertiesHandlers } from '@/lib/tauri-mock/handlers/properties'
import {
  type TypedHandlers,
  appErrorRejection,
  assertTagFilterWithinCap,
  assertValidDateFormat,
  assertValidSetPropertyValue,
  blockLastEditedAt,
  buildPageMetaRow,
  compareMetaRows,
  comparePositionThenId,
  createPageInSpace,
  definitionSpaceOf,
  linkEdges,
  encodeNextCursor,
  metaRowMatchesFilter,
  notFoundRejection,
  isLiveSpace,
  isPageSort,
  ownerSpaceOf,
  type PageSortRow,
  pagesLastEditedAt,
  propertyDefinition,
  sortDiscriminator,
  titleSortKey,
  validationRejection,
  readActiveSpaceScope,
} from '@/lib/tauri-mock/handlers/shared'
import { tagsHandlers } from '@/lib/tauri-mock/handlers/tags'
import {
  findEmptyPageTitled,
  resolveInboundNames,
  resolveRefValue,
  resolveTagNames,
} from '@/lib/tauri-mock/names'
import {
  blockTags,
  blocks,
  fakeId,
  makeBlock,
  opLog,
  pageAliases,
  pageOpens,
  properties,
  pushOp,
  seedDefaultPropertyDefs,
} from '@/lib/tauri-mock/seed'

/**
 * The metadata-rich row for every live page in `spaceId`. Its
 * `lastModifiedAt` is page-wide, `pages_cache.last_edited_ms`, and it carries
 * the title key and the open stamp the sorts read (#5371).
 */
function pageSortRows(spaceId: string): PageSortRow[] {
  // Block-link edges derived from `[[ULID]]` tokens (mock stand-in for the
  // backend's `block_links` table) so the link facets and `MostLinked` sort
  // reflect the seed's real topology.
  const edges = linkEdges()
  const lastEditedByPage = pagesLastEditedAt()
  const byPage = new Map<unknown, Array<Record<string, unknown>>>()
  for (const d of blocks.values()) {
    if (d['deleted_at'] || d['id'] === d['page_id']) continue
    const list = byPage.get(d['page_id'])
    if (list) list.push(d)
    else byPage.set(d['page_id'], [d])
  }
  const rows: PageSortRow[] = []
  for (const b of blocks.values()) {
    if (b['block_type'] !== 'page' || b['deleted_at']) continue
    if (ownerSpaceOf(b) !== spaceId) continue
    const id = b['id'] as string
    rows.push({
      ...buildPageMetaRow(b, byPage.get(id) ?? [], edges),
      lastModifiedAt: lastEditedByPage.get(id) ?? blockLastEditedAt(id),
      titleSortKey: titleSortKey((b['content'] as string | null) ?? ''),
      openedMs: pageOpens.get(id) ?? -1,
    })
  }
  return rows
}

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

type OpRefs = Array<{ device_id: string; seq: number }>

/** `parentId`'s live children in sibling order, hidden ones included. */
function liveChildren(parentId: string): Record<string, unknown>[] {
  return [...blocks.values()]
    .filter((b) => b['parent_id'] === parentId && !b['deleted_at'])
    .toSorted(comparePositionThenId)
}

/**
 * DELIBERATE APPROXIMATION of `render_page_source` (#5140): the page's front
 * matter ({@link renderFrontMatter}), then every live content descendant,
 * depth-first in sibling order, as `- content ^ID` with its further lines
 * indented under the bullet. Like the backend, a nested page and what is under
 * it are left out. No list markers, task checkboxes or property lines — the
 * Rust tests own that grammar, and a faithful port is the second
 * implementation #5140 deletes. Returns the buffer and the ids it holds, in
 * order.
 */
function renderPageSource(pid: string): { source: string; ids: string[] } {
  requirePageToRender(pid)
  let source = renderFrontMatter(pageFrontMatter(pid))
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

/**
 * Like the backend's `load_page_row`: a trashed page is not found, and a block
 * that is not a page is a validation error.
 */
function requirePageToRender(pid: string): void {
  const page = blocks.get(pid)
  if (!page || page['deleted_at']) throw notFoundRejection(`page '${pid}' not found`)
  if (page['block_type'] !== 'page') throw validationRejection('not a page')
}

/**
 * The block property keys a buffer writes no line for: the reserved keys and
 * the list style (`load_descendant_properties`).
 */
const BLOCK_LINE_HIDDEN_KEYS: ReadonlySet<string> = new Set([
  ...INLINE_PROPERTY_RESERVED_KEYS,
  'listStyle',
])

/** `listStyle` as the backend reads it for a marker: `bullet`, `ordered` or none. */
function storedListStyle(id: string): string | null {
  const style = properties.get(id)?.get('listStyle')?.['value_text']
  return style === 'bullet' || style === 'ordered' ? style : null
}

/**
 * `push_block_bullet` in a Document buffer: the markers and the first line,
 * escaped when it would read as something else, then the further lines at the
 * text's column, each escaped that would read as anything but that line of
 * the block. Outside a fence an escaped line opens none, so only the first
 * line can. Returns whether the last line is code (`CodeLines::last`).
 */
function pushDocumentLines(
  lines: string[],
  indent: string,
  listMarker: string,
  taskMarker: string,
  text: string,
): boolean {
  const [first = '', ...rest] = text.split('\n')
  const markers = listMarker + taskMarker
  let head = indent + markers
  if (first === '' && markers !== '') {
    head = indent + markers.trimEnd()
  } else {
    const escape =
      listMarker === ''
        ? needsBareLineEscape(first, rest.length > 0)
        : taskMarker === '' && needsTaskMarkerEscape(first)
    head += (escape ? '\\' : '') + first
  }
  lines.push(head)
  let fence = documentFenceOpener(head)
  let last = fence !== null
  const column = indent + ' '.repeat(listMarker.length)
  for (const line of rest) {
    const escape = fence === null ? needsDocumentLineEscape(line) : needsAnchorLineEscape(line)
    const written = column + (escape ? '\\' : '') + line
    last = fence !== null
    if (fence !== null && closesFence(written, fence)) fence = null
    lines.push(written)
  }
  return last
}

/**
 * `push_anchored_source_bullet` in a Document buffer: the block with its `^ID`
 * ending its last line or, when that line is code or would be written as an
 * escaped blank line, on a line of its own at the text's column.
 */
function pushAnchoredDocumentBlock(
  lines: string[],
  indent: string,
  listMarker: string,
  taskMarker: string,
  content: string,
  id: string,
): void {
  const lastLine = content.includes('\n') ? content.slice(content.lastIndexOf('\n') + 1) : null
  if (lastLine === null || !needsBlankLineEscape(lastLine)) {
    const start = lines.length
    if (!pushDocumentLines(lines, indent, listMarker, taskMarker, `${content} ^${id}`)) return
    lines.length = start
  }
  pushDocumentLines(lines, indent, listMarker, taskMarker, content)
  lines.push(`${indent}${' '.repeat(listMarker.length)}^${id}`)
}

/**
 * `render_page_document` (#5691, `Dialect::Document.render`): the page's front
 * matter ({@link renderFrontMatter}), then every live content descendant,
 * depth-first in sibling order, each with its `^ID`. A plain block is its own
 * paragraph, a bullet block `- x`, a numbered one `N. x` by its place in its
 * run, a task `- [ ] x`, which shows no list style (D3); a blank line goes
 * between blocks but neighbouring marked ones (D1). A plain block under a
 * marked one, or opening the buffer with `---`, is a `+` item (D4). Its task
 * state outside the checkbox alphabet, its priority and dates and its other
 * properties follow as `key:: value` lines at its text's column. Like the
 * backend, a nested page and what is under it are left out; unlike it, no id
 * in the text is written as a name. Returns the buffer and the ids it holds,
 * in order.
 */
function renderPageDocument(pid: string): { source: string; ids: string[] } {
  requirePageToRender(pid)
  const front = renderFrontMatter(pageFrontMatter(pid))
  const lines: string[] = []
  const ids: string[] = []
  const open: Array<{ column: number; marked: boolean }> = []
  let previousMarked: boolean | null = null
  const render = (parentId: string, depth: number): void => {
    const children = liveChildren(parentId).filter((row) => row['block_type'] === 'content')
    let run = 0
    for (const row of children) {
      const id = row['id'] as string
      const content = (row['content'] as string | null) ?? ''
      const todo = (row['todo_state'] as string | null) ?? null
      const style = storedListStyle(id)
      run = style === 'ordered' && todo === null ? run + 1 : 0
      const checkbox = checkboxOf(todo)
      open.length = depth
      const { column, marked: underMarker } = open.at(-1) ?? { column: 0, marked: false }
      let marker = ''
      if (checkbox !== null) marker = '- '
      else if (todo === null && style !== null) marker = style === 'bullet' ? '- ' : `${run}. `
      else if (underMarker || (front === '' && lines.length === 0 && content.startsWith('---'))) {
        marker = '+ '
      }
      const marked = marker !== ''
      if (previousMarked !== null && !(previousMarked && marked)) lines.push('')
      previousMarked = marked
      const child = column + (marked ? marker.length : 2)
      open.push({ column: child, marked })
      const taskMarker = checkbox === null ? '' : `[${checkbox}] `
      pushAnchoredDocumentBlock(lines, ' '.repeat(column), marker, taskMarker, content, id)
      pushPropertyLines(lines, ' '.repeat(child), row, checkbox === null ? todo : null)
      ids.push(id)
      render(id, depth + 1)
    }
  }
  render(pid, 0)
  return { source: front + lines.map((line) => `${line}\n`).join(''), ids }
}

/** The checkbox `todo` is written as, `null` outside the alphabet (`task_marker_for`). */
function checkboxOf(todo: string | null): string | null {
  return todo !== null && Object.hasOwn(TASK_STATE_TO_MARKER, todo)
    ? TASK_STATE_TO_MARKER[todo as TodoState]
    : null
}

/**
 * A block's `key:: value` lines at `indent`, as `render_block` writes them:
 * `todo` when its checkbox does not carry it, its priority and dates, then its
 * other properties by key, each value as the line reads it back.
 */
function pushPropertyLines(
  lines: string[],
  indent: string,
  row: Record<string, unknown>,
  todo: string | null,
): void {
  const reserved = [
    ['todo_state', todo],
    ['priority', row['priority']],
    ['scheduled_date', row['scheduled_date']],
    ['due_date', row['due_date']],
  ] as const
  for (const [key, value] of reserved) {
    if (typeof value === 'string' && value !== '') lines.push(`${indent}${key}:: ${value}`)
  }
  const rows = [...(properties.get(row['id'] as string) ?? [])]
    .filter(([key]) => !BLOCK_LINE_HIDDEN_KEYS.has(key))
    .toSorted(([a], [b]) => compareUtf8Bytes(a, b))
  for (const [key, value] of rows) {
    lines.push(`${indent}${key}:: ${writeSourcePropertyValue(frontMatterValue(value))}`)
  }
}

/** The page's properties, aliases and tags, as its front matter writes them (#5160 S8). */
interface FrontMatter {
  properties: Map<string, string>
  aliases: string[]
  tags: string[]
}

/** The page keys the export leaves out of front matter (`load_page_properties`). */
const FRONT_MATTER_HIDDEN_KEYS: ReadonlySet<string> = new Set([
  ...INLINE_PROPERTY_RESERVED_KEYS,
  'listStyle',
  'aliases',
  'tags',
])

const FOLDED_RESERVED_KEYS: ReadonlySet<string> = new Set(
  [...INLINE_PROPERTY_RESERVED_KEYS].map(foldPropertyKey),
)

/** `frontmatter_row_value` with no titles: a ref value is its id. */
function frontMatterValue(row: Record<string, unknown>): string {
  const text = row['value_date'] ?? row['value_text'] ?? row['value_ref']
  if (typeof text === 'string') return text
  if (typeof row['value_num'] === 'number') return String(row['value_num'])
  return row['value_bool'] == null ? '' : String(row['value_bool'] !== 0)
}

/** What `pid`'s front matter holds: `load_page_properties` and `load_frontmatter_lists`. */
function pageFrontMatter(pid: string): FrontMatter {
  const rows = [...(properties.get(pid) ?? [])]
    .filter(([key]) => !FRONT_MATTER_HIDDEN_KEYS.has(key))
    .toSorted(([a], [b]) => compareUtf8Bytes(a, b))
  const tags = [...(blockTags.get(pid) ?? [])]
    .map((tagId) => blocks.get(tagId))
    .filter(
      (tag): tag is Record<string, unknown> =>
        tag?.['block_type'] === 'tag' && !tag['deleted_at'] && tag['content'] != null,
    )
    .toSorted(
      (a, b) =>
        compareNocase(a['content'] as string, b['content'] as string) ||
        compareUtf8Bytes(a['id'] as string, b['id'] as string),
    )
  return {
    properties: new Map(rows.map(([key, row]) => [key, frontMatterValue(row)])),
    aliases: (pageAliases.get(pid) ?? []).toSorted(compareNocase),
    tags: tags.map((tag) => tag['content'] as string),
  }
}

/**
 * DELIBERATE APPROXIMATION of `render_frontmatter`: the export's YAML, written
 * only when there is something to write, every value and list item bare. The
 * Rust tests own the quoting and the block scalars.
 */
function renderFrontMatter(front: FrontMatter): string {
  if (front.properties.size === 0 && front.aliases.length === 0 && front.tags.length === 0) {
    return ''
  }
  let yaml = '---\n'
  if (front.aliases.length > 0) yaml += `aliases: [${front.aliases.join(', ')}]\n`
  if (front.tags.length > 0) yaml += `tags: [${front.tags.join(', ')}]\n`
  for (const [key, value] of front.properties) yaml += `${key}: ${value}\n`
  return `${yaml}---\n\n`
}

/** One layer of matching quotes off `value`, as `strip_yaml_quotes` takes it. */
function unquoteYaml(value: string): string {
  const quoted = /^"(.*)"$/s.exec(value) ?? /^'(.*)'$/s.exec(value)
  return quoted?.[1] ?? value
}

/** A refusal at buffer line `line`, prefixed with it as the backend's are (`at_line`). */
function refusedAt(line: number | undefined, message: string): Error {
  return validationRejection(line === undefined ? message : `line ${line}: ${message}`)
}

/**
 * DELIBERATE APPROXIMATION of `import::read_page_properties` (#5160 S8): the
 * YAML front matter a buffer opens with, as `key: value` lines, `aliases:` and
 * `tags:` as `[a, b]` lists split on every comma, one layer of quotes
 * stripped. A line that is none of these, a key only the app sets and a key
 * written twice refuse the save by their line, as does a `---` nothing
 * closes. No Logseq `key::` lines, block scalars or block sequences. Returns
 * the front matter, each key's line, and the buffer with its lines left blank,
 * so a block after it names its line in the buffer (#5160 X3).
 */
function readFrontMatter(source: string): {
  front: FrontMatter
  lines: Map<string, number>
  body: string
} {
  const front: FrontMatter = { properties: new Map(), aliases: [], tags: [] }
  const lines = new Map<string, number>()
  const rows = source.split('\n')
  if (rows[0] !== '---') return { front, lines, body: source }
  const close = rows.indexOf('---', 1)
  if (close < 0) {
    throw refusedAt(1, 'the front matter this `---` opens has no closing `---`')
  }
  for (let at = 1; at < close; at++) {
    const text = (rows[at] ?? '').trim()
    if (text === '' || text.startsWith('#')) continue
    const colon = text.indexOf(':')
    const key = colon < 0 ? '' : text.slice(0, colon).trim()
    const refuse = (why: string) => refusedAt(at + 1, why)
    if (!isInlinePropertyKey(key)) throw refuse(`\`${text}\` is not a \`key: value\` line`)
    if (FOLDED_RESERVED_KEYS.has(foldPropertyKey(key))) {
      throw refuse(`\`${key}\` is kept by the app, not the front matter`)
    }
    if (lines.has(key)) throw refuse(`\`${key}\` is written twice`)
    lines.set(key, at + 1)
    const value = text.slice(colon + 1).trim()
    if (key === 'aliases' || key === 'tags') {
      front[key] = value
        .replace(/^\[(.*)\]$/s, '$1')
        .split(',')
        .map((item) => unquoteYaml(item.trim()))
        .filter((item) => item !== '')
    } else {
      front.properties.set(key, unquoteYaml(value))
    }
  }
  return { front, lines, body: rows.map((row, at) => (at > close ? row : '')).join('\n') }
}

/** What a save writes to the page's front matter (`markdown_source_front_matter.rs`). */
interface FrontMatterWrites {
  set: Array<[string, string]>
  deleted: string[]
  /** The page's aliases after the save, or `null` when they stay. */
  aliases: string[] | null
  tagsAdded: string[]
  tagsRemoved: string[]
}

/**
 * What `to` changed from `from`, the front matter the edit started from, less
 * what the page (`now`) already holds: a merge keeps what the page changed
 * since. Each value set is checked as `set_property` checks it first, a
 * refusal naming its line, so nothing is written.
 */
function frontMatterWrites(
  spaceId: string | null,
  from: FrontMatter,
  to: FrontMatter,
  now: FrontMatter,
  lines: ReadonlyMap<string, number>,
): FrontMatterWrites {
  const set = [...to.properties].filter(
    ([key, value]) =>
      value !== '' && from.properties.get(key) !== value && now.properties.get(key) !== value,
  )
  for (const [key, value] of set) {
    try {
      assertValidSetPropertyValue(spaceId, key, value)
    } catch (err) {
      const reason = (err as { message?: unknown }).message
      throw refusedAt(lines.get(key), `\`${key}: ${value}\` cannot be saved: ${String(reason)}`)
    }
  }
  const has = (list: readonly string[], item: string) => list.includes(item)
  const tag = (list: readonly string[], name: string) =>
    list.some((held) => normalizeTagName(held) === normalizeTagName(name))
  const aliases = [
    ...now.aliases.filter((alias) => !has(from.aliases, alias) || has(to.aliases, alias)),
    ...to.aliases.filter((alias) => !has(from.aliases, alias) && !has(now.aliases, alias)),
  ]
  return {
    set,
    deleted: [...from.properties.keys()].filter(
      (key) => !(to.properties.get(key) ?? '') && now.properties.has(key),
    ),
    aliases: aliases.join('\n') === now.aliases.join('\n') ? null : aliases,
    tagsAdded: to.tags.filter((name) => !tag(from.tags, name) && !tag(now.tags, name)),
    tagsRemoved: from.tags.filter((name) => !tag(to.tags, name) && tag(now.tags, name)),
  }
}

/** `aliases` trimmed, without empty entries or a second spelling of one alias (`wanted_aliases`). */
function wantedAliases(aliases: readonly string[]): string[] {
  const keys = new Set<string>()
  const out: string[] = []
  for (const raw of aliases) {
    const alias = raw.trim()
    if (alias === '' || keys.has(foldAsciiUppercase(alias))) continue
    keys.add(foldAsciiUppercase(alias))
    out.push(alias)
  }
  return out
}

/** The page other than `pageId` holding `alias` (`page_aliases.alias` is NOCASE), if any. */
function aliasHolder(alias: string, pageId: string): string | null {
  for (const [owner, held] of pageAliases) {
    if (owner === pageId) continue
    if (held.some((h) => foldAsciiUppercase(h) === foldAsciiUppercase(alias))) return owner
  }
  return null
}

/** `require_live_page`: the alias writes probe for a live page block first (#661). */
function requireLivePage(pageId: string): void {
  const page = blocks.get(pageId)
  if (!page || page['block_type'] !== 'page' || page['deleted_at']) {
    throw notFoundRejection('page not found')
  }
}

/** The aliases a write of `wanted` removes (in `ORDER BY alias` order) and adds. */
function aliasEdit(pageId: string, wanted: readonly string[]) {
  const held = (pageAliases.get(pageId) ?? []).toSorted(compareNocase)
  return {
    removed: held.filter((alias) => !wanted.includes(alias)),
    added: wanted.filter((alias) => !held.includes(alias)),
  }
}

/**
 * `write_page_aliases_in_tx`: a `remove_page_alias` op per alias that goes,
 * then an `add_page_alias` per alias that comes, skipping one another page
 * holds. Returns the ops and the skipped aliases.
 */
function writePageAliases(pageId: string, wanted: readonly string[]) {
  requireLivePage(pageId)
  const { removed, added } = aliasEdit(pageId, wanted)
  const taken = added.filter((alias) => aliasHolder(alias, pageId) !== null)
  const ops = [
    ...removed.map((alias) => pushOp('remove_page_alias', { page_id: pageId, alias })),
    ...added
      .filter((alias) => !taken.includes(alias))
      .map((alias) => pushOp('add_page_alias', { page_id: pageId, alias })),
  ]
  pageAliases.set(
    pageId,
    wanted.filter((alias) => !taken.includes(alias)),
  )
  return { opRefs: ops.map((op) => ({ device_id: op.device_id, seq: op.seq })), taken }
}

/**
 * Write `writes` to `pageId` through the property, alias and tag commands: a
 * tag name no tag of the space has is created. Returns the counts.
 */
function writeFrontMatter(
  pageId: string,
  writes: FrontMatterWrites,
  spaceId: string | null,
  out: { opRefs: OpRefs; namesCreated: Record<string, unknown>[]; warnings: string[] },
): { properties_set: number; properties_deleted: number } {
  for (const key of writes.deleted) {
    out.opRefs.push(...propertiesHandlers.delete_property({ blockId: pageId, key }).op_refs)
  }
  for (const [key, value] of writes.set) {
    const row = propertiesHandlers.set_property({
      blockId: pageId,
      key,
      value: {
        value_text: value,
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    }) as { op_refs: OpRefs } | null
    out.opRefs.push(...(row?.op_refs ?? []))
  }
  if (writes.aliases !== null) {
    const written = writePageAliases(pageId, wantedAliases(writes.aliases))
    out.opRefs.push(...written.opRefs)
    for (const alias of written.taken) {
      out.warnings.push(`alias '${alias}' is already used by another page; not applied to the page`)
    }
  }
  for (const name of writes.tagsRemoved) {
    const tagId = [...(blockTags.get(pageId) ?? [])].find(
      (id) =>
        normalizeTagName((blocks.get(id)?.['content'] as string) ?? '') === normalizeTagName(name),
    )
    if (tagId) out.opRefs.push(...tagsHandlers.remove_tag({ blockId: pageId, tagId }).op_refs)
  }
  if (spaceId === null) {
    for (const name of writes.tagsAdded) {
      out.warnings.push(`tag '${name}' names no tag of the page's space; not applied`)
    }
  } else if (writes.tagsAdded.length > 0) {
    const tags = resolveTagNames(writes.tagsAdded, spaceId, out.opRefs)
    out.namesCreated.push(...tags.created)
    for (const tagId of tags.ids.values()) {
      out.opRefs.push(...tagsHandlers.add_tag({ blockId: pageId, tagId }).op_refs)
    }
  }
  return { properties_set: writes.set.length, properties_deleted: writes.deleted.length }
}

interface SourceBullet {
  content: string
  depth: number
  anchor: string | null
  /** The buffer line the bullet starts on, which a refusal names (#5160 X3). */
  line?: number | undefined
  /** A Document line's marker, checkbox and property lines; a Source line has none (#5691). */
  marks?: Marks | undefined
  /** What the save writes to the block beside its text, planned by {@link planMarkWrites}. */
  writes?: MarkWrites | undefined
}

type Marks = Pick<DocumentBlock, 'listStyle' | 'todoState' | 'properties'>

/** What a save writes to a block beside its text (`PropertyChanges`, `write_properties`). */
interface MarkWrites {
  deleted: string[]
  /** By key for a block the page holds, in line order for one the save creates. */
  set: Array<[key: string, value: string]>
  /** The task state, written last: `null` clears it. */
  todoState: { to: string | null } | null
}

/** The ` ^word` a source block ends with, when it is id-sized. */
const SOURCE_ANCHOR_RE = /(?:^|\s)\^([0-9A-Za-z]{26})\s*$/

/** What `BlockId::from_string` reads: Crockford base32, either case, in 128 bits. */
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i

/**
 * Whether a caret word is a block id: anything else is text, as the backend's
 * `anchor_free` keeps it. The mock's own ids (`…BLOCK01`, `…MOCK…`) spell letters
 * outside Crockford, so a word naming a block the mock holds is one too.
 */
function isBlockId(word: string): boolean {
  return ULID_RE.test(word) || blocks.has(word)
}

/**
 * A source buffer's blocks ({@link parseOutline}), each trailing ` ^id` split
 * off, a ULID read uppercase as the backend reads it. The save models no task
 * checkboxes, so one `parseOutline` read goes back into the text it was read
 * from.
 */
function parseSourceBuffer(source: string): SourceBullet[] {
  return parseOutline(source).map(({ content: text, depth, todoState, line }) => {
    const content = todoState
      ? `[${TASK_STATE_TO_MARKER[todoState]}]${text === '' ? '' : ` ${text}`}`
      : text
    const match = SOURCE_ANCHOR_RE.exec(content)
    const word = match?.[1]
    if (!match || word === undefined || !isBlockId(word))
      return { content, depth, anchor: null, line }
    const anchor = ULID_RE.test(word) ? word.toUpperCase() : word
    return { content: content.slice(0, match.index), depth, anchor, line }
  })
}

/**
 * The text `get_page_buffer` gives (#5160 A): `source` less the ` ^ID` each
 * block's last line ends in, and the id each line carries, the block's on the
 * line it starts on. The front matter's lines are kept as written, carrying
 * none (#5160 S8). The mock's render writes no anchor on a line of its own, so
 * there is none to drop.
 */
function anchorFree(source: string): { text: string; lineIds: Array<string | null> } {
  const lines = source.split('\n')
  const lineIds: Array<string | null> = lines.map(() => null)
  for (const bullet of parseSourceBuffer(readFrontMatter(source).body)) {
    if (bullet.anchor === null || bullet.line === undefined) continue
    const last = bullet.line - 1 + bullet.content.split('\n').length - 1
    const line = lines[last] ?? ''
    const suffix = ` ^${bullet.anchor}`
    if (line.toUpperCase().endsWith(suffix.toUpperCase())) {
      lines[last] = line.slice(0, -suffix.length)
    }
    lineIds[bullet.line - 1] = bullet.anchor
  }
  return { text: lines.join('\n'), lineIds }
}

/** `text` read with its ids beside it on `lineIds`, no id assigned yet. */
function parseTextBuffer(
  text: string,
  lineIds: ReadonlyArray<string | null>,
  warnings: string[],
): SourceBullet[] {
  const idLines = new Set(lineIds.flatMap((carried, i) => (carried === null ? [] : [i + 1])))
  return parseOutline(text, { idLines, warnings }).map(({ content, depth, todoState, line }) => ({
    content: todoState
      ? `[${TASK_STATE_TO_MARKER[todoState]}]${content === '' ? '' : ` ${content}`}`
      : content,
    depth,
    anchor: null,
    line,
  }))
}

/**
 * `anchor_free_as` for a Document buffer (#5691): `source` less the `^ID` each
 * block wrote, at the end of its last line or on a line of its own, which
 * goes, and the id each line carries, the block's on the line it starts on.
 */
function anchorFreeDocument(source: string): { text: string; lineIds: Array<string | null> } {
  const lines = source.split('\n')
  const lineIds: Array<string | null> = lines.map(() => null)
  const ownLines = new Set<number>()
  for (const block of parseDocument(source, null, isBlockId).blocks) {
    const word = block.anchor
    if (word === null || !isBlockId(word)) continue
    const last = block.line - 1 + block.content.split('\n').length - 1
    const anchor = `^${word}`
    const line = lines[last]
    if (lines[last + 1]?.trim() === anchor) ownLines.add(last + 1)
    else if (line?.endsWith(` ${anchor}`)) lines[last] = line.slice(0, -anchor.length - 1)
    lineIds[block.line - 1] = ULID_RE.test(word) ? word.toUpperCase() : word
  }
  const kept = (_: unknown, i: number) => !ownLines.has(i)
  return { text: lines.filter(kept).join('\n'), lineIds: lineIds.filter(kept) }
}

/** {@link parseTextBuffer} for a Document buffer: its blocks as the Rust grammar reads them. */
function parseDocumentBuffer(
  text: string,
  lineIds: ReadonlyArray<string | null>,
  warnings: string[],
): SourceBullet[] {
  const read = parseDocument(text, lineIds)
  warnings.push(...read.warnings)
  return read.blocks.map(({ content, depth, line, listStyle, todoState, properties: lines }) => ({
    content,
    depth,
    anchor: null,
    line,
    marks: { listStyle, todoState, properties: lines },
  }))
}

/** How a buffer in one dialect is rendered, freed of its anchors and read by its ids (#5691). */
interface BufferGrammar {
  render: (pid: string) => { source: string; ids: string[] }
  anchorFree: (source: string) => { text: string; lineIds: Array<string | null> }
  read: (text: string, lineIds: ReadonlyArray<string | null>, warnings: string[]) => SourceBullet[]
}

const SOURCE_GRAMMAR: BufferGrammar = {
  render: renderPageSource,
  anchorFree,
  read: parseTextBuffer,
}

const DOCUMENT_GRAMMAR: BufferGrammar = {
  render: renderPageDocument,
  anchorFree: anchorFreeDocument,
  read: parseDocumentBuffer,
}

/** The grammar of the dialect a buffer command names, Source when none, as the backend reads it. */
function grammarOf(args: Record<string, unknown>): BufferGrammar {
  return args['dialect'] === 'document' ? DOCUMENT_GRAMMAR : SOURCE_GRAMMAR
}

/** A page's own source read as the text {@link anchorFree} makes of it, each block under its id. */
function readOwnText(source: string, grammar: BufferGrammar): SourceBullet[] {
  const { text, lineIds } = grammar.anchorFree(source)
  const bullets = grammar.read(text, lineIds, [])
  for (const bullet of bullets) {
    bullet.anchor = bullet.line === undefined ? null : (lineIds[bullet.line - 1] ?? null)
  }
  return bullets
}

/**
 * Mirrors `read_by_line` (`markdown_source_apply.rs`): `text` read into
 * bullets, each under the id `lineIds` gives the line it starts on, refused
 * unless `lineIds` holds one entry per line. A copy is a new block and a cut
 * is a move (#5160 D15): an id on more than one line stays with the first,
 * and one that is not `known` is read as none, each with a warning naming the
 * line.
 */
function readByLine(
  text: string,
  lineIds: ReadonlyArray<string | null>,
  known: ReadonlySet<string>,
  warnings: string[],
  grammar: BufferGrammar,
): SourceBullet[] {
  const lines = text.replace(/\r\n/g, '\n').split(/[\n\r]/).length
  if (lineIds.length !== lines) {
    throw validationRejection(
      `line_ids holds ${lineIds.length} entries for the ${lines} lines of the text`,
    )
  }
  const bullets = grammar.read(text, lineIds, warnings)
  const first = new Map<string, number>()
  for (const bullet of bullets) {
    const line = bullet.line ?? 0
    const carried = lineIds[line - 1] ?? null
    if (carried === null) continue
    const id = known.has(carried) ? carried : carried.toUpperCase()
    const at = first.get(id)
    if (!known.has(id)) {
      warnings.push(`line ${line}: not a block of this page; saved as a new block`)
    } else if (at !== undefined) {
      warnings.push(`line ${line}: a copy of the block on line ${at}; saved as a new block`)
    } else {
      first.set(id, line)
      bullet.anchor = id
    }
  }
  return bullets
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
 * takes that side's text; changed on both, its text or one property two ways,
 * the page's stays and the buffer's is forked as a new block before it. A
 * delete on one side stands unless the other side changed the block, its text
 * or a property, or moved it to another parent. DELIBERATE
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
      if (b !== undefined && sameBlock(b, c) && !moved(current, key)) continue
      if (b !== undefined) {
        warnings.push(warningAbout(c.content, 'changed on the page; your delete was not applied'))
      }
      kept.set(key, { content: c.content, anchor: key, fork: null })
    } else if (clashes(b, c, m)) {
      warnings.push(warningAbout(c.content, 'was changed here and on the page; both versions kept'))
      kept.set(key, { content: c.content, anchor: key, fork: m.content })
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
    } else if (!sameBlock(b, m) || moved(mine, key)) {
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
      const marks = outlines.mine.byKey.get(key)?.marks
      if (block.fork !== null) merged.push({ content: block.fork, depth, anchor: null, marks })
      // A forked block stays the page's: the buffer's marks went with the fork.
      merged.push({
        content: block.content,
        depth,
        anchor: block.anchor,
        marks: block.fork === null ? marks : undefined,
      })
      emit(key, depth + 1)
    }
  }
  emit(null, 0)
  return merged
}

/** `marks` as the save reads a block's properties: the style and state its markers give, then its lines, the last for a key winning. */
function markProperties({ listStyle, todoState, properties: lines }: Marks): Map<string, string> {
  const markers: Array<[string, string]> = []
  if (listStyle !== null) markers.push(['listStyle', listStyle])
  if (todoState !== null) markers.push(['todo_state', todoState])
  return new Map([...markers, ...lines])
}

/**
 * What a save writes to a block the page holds beside its text
 * (`PropertyChanges::between`): the keys the buffer dropped, the values it
 * changed by key, and the task state, written last. A value the page has
 * already (`now`) is not written again, so a merge keeps what the page changed
 * since `from`, the source the edit started from. A task's hidden list style
 * goes with any edit to the block, unless the buffer restyles it.
 */
function planMarkWrites(
  marks: { from: Marks; to: Marks; now: Marks },
  hidesListStyle: boolean,
  textEdited: boolean,
): MarkWrites {
  const [was, wants, holds] = [marks.from, marks.to, marks.now].map(markProperties) as [
    Map<string, string>,
    Map<string, string>,
    Map<string, string>,
  ]
  for (const [key, value] of wants) if (value === '') wants.delete(key)
  const byKey = ([a]: [string, unknown], [b]: [string, unknown]) => compareUtf8Bytes(a, b)
  const changed = [...wants]
    .filter(([key, value]) => was.get(key) !== value && holds.get(key) !== value)
    .toSorted(byKey)
  const dropped = [...was.keys()]
    .filter((key) => !wants.has(key) && holds.has(key))
    .toSorted(compareUtf8Bytes)
  const set = changed.filter(([key]) => key !== 'todo_state')
  const deleted = dropped.filter((key) => key !== 'todo_state')
  const state = changed.find(([key]) => key === 'todo_state')
  const todoState = state ? { to: state[1] } : dropped.includes('todo_state') ? { to: null } : null
  const restyled = set.some(([key]) => key === 'listStyle')
  const any = set.length > 0 || deleted.length > 0 || todoState !== null
  if ((textEdited || any) && !restyled && hidesListStyle) deleted.push('listStyle')
  return { deleted, set, todoState }
}

/** A bullet's properties as the save reads them; a Source bullet has none the mock reads. */
function bulletProperties({ marks }: SourceBullet): Map<string, string> {
  return marks === undefined ? new Map() : markProperties(marks)
}

/** `same` (`markdown_source_merge.rs`): one text and one value for every key. */
function sameBlock(x: SourceBullet, y: SourceBullet): boolean {
  const [a, b] = [bulletProperties(x), bulletProperties(y)]
  return x.content === y.content && a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)
}

/** Whether `c` and `m` changed one property of `b` two ways, which `merge_block` cannot merge. */
function clashes(b: SourceBullet | undefined, c: SourceBullet, m: SourceBullet): boolean {
  if (b === undefined) return false
  const sides = [b, c, m].map(bulletProperties)
  const keys = new Set(sides.flatMap((side) => [...side.keys()]))
  return [...keys].some((key) => new Set(sides.map((side) => side.get(key))).size === 3)
}

/** What a save writes to a block it creates: every property its markers and lines give. */
function newMarkWrites(marks: Marks): MarkWrites {
  const set = [...markProperties(marks)].filter(([, value]) => value !== '')
  return { deleted: [], set, todoState: null }
}

/** The typed value columns `key:: value` is written to (`typed_property_args_for_registry_value`). */
function lineColumns(spaceId: string | null, key: string, value: string): Record<string, unknown> {
  const type = propertyDefinition(spaceId, key)?.['value_type']
  const word = value.trim()
  if (type === 'number' && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(word)) {
    return { value_num: Number(word) }
  }
  if (type === 'boolean' && /^(?:true|false)$/i.test(word)) {
    return { value_bool: word.toLowerCase() === 'true' }
  }
  if (type === 'date') return { value_date: value }
  return { value_text: value }
}

/** Refuse a `key:: value` line `set_property` would, as the save refuses it: naming the line. */
function checkLineValue(bullet: SourceBullet, spaceId: string | null, key: string, value: string) {
  try {
    assertValidSetPropertyValue(spaceId, key, value)
    if (lineColumns(spaceId, key, value)['value_date'] !== undefined) assertValidDateFormat(value)
    if (propertyDefinition(spaceId, key)?.['value_type'] === 'ref') resolveRefValue(value, spaceId)
  } catch (err) {
    const reason = (err as { message?: unknown }).message
    throw refusedAt(bullet.line, `\`${key}:: ${value}\` cannot be saved: ${String(reason)}`)
  }
}

/**
 * Plan the writes beside the text of every bullet of a Document buffer,
 * refusing a value `set_property` would before anything is written. A bullet
 * whose block the page holds is compared with that block as the buffer
 * started from it (`from`) and as the page has it now.
 */
function planBufferMarks(
  t1: SourceBullet[],
  held: {
    from: ReadonlyMap<string, Marks>
    now: ReadonlyMap<string, Marks>
    before: ReadonlyMap<string | null, string>
  },
  spaceId: string | null,
): void {
  for (const bullet of t1) {
    const { anchor, marks } = bullet
    if (marks === undefined) continue
    const now = anchor === null ? undefined : held.now.get(anchor)
    if (anchor === null || now === undefined) {
      bullet.writes = newMarkWrites(marks)
    } else {
      const from = held.from.get(anchor) ?? now
      const edited = bullet.content !== held.before.get(anchor)
      const hidden = properties.get(anchor)?.has('listStyle') === true && now.listStyle === null
      bullet.writes = planMarkWrites({ from, to: marks, now }, hidden, edited)
    }
    for (const [key, value] of bullet.writes.set) checkLineValue(bullet, spaceId, key, value)
    const state = bullet.writes.todoState?.to
    if (state) checkLineValue(bullet, spaceId, 'todo_state', state)
  }
}

/**
 * The column-backed keys, written by their own commands as the editor writes
 * them, whose ops an undo reverts.
 */
const COLUMN_WRITERS: ReadonlyMap<string, (blockId: string, value: string | null) => unknown> =
  new Map([
    ['todo_state', (blockId, state) => propertiesHandlers.set_todo_state({ blockId, state })],
    ['priority', (blockId, level) => propertiesHandlers.set_priority({ blockId, level })],
    ['due_date', (blockId, date) => propertiesHandlers.set_due_date({ blockId, date })],
    ['scheduled_date', (blockId, date) => propertiesHandlers.set_scheduled_date({ blockId, date })],
  ])

/**
 * `writes` applied to block `id`: the keys taken off, those set, then the task
 * state (`write_properties`). Returns the refs of every op it appended, the
 * stamps a task state writes included.
 */
function writeMarks(id: string, writes: MarkWrites): OpRefs {
  const spaceId = definitionSpaceOf(id)
  const start = opLog.length
  for (const key of writes.deleted) propertiesHandlers.delete_property({ blockId: id, key })
  for (const [key, value] of writes.set) {
    const column = COLUMN_WRITERS.get(key)
    if (column === undefined) {
      propertiesHandlers.set_property({ blockId: id, key, value: lineColumns(spaceId, key, value) })
    } else {
      column(id, value)
    }
  }
  if (writes.todoState !== null) COLUMN_WRITERS.get('todo_state')?.(id, writes.todoState.to)
  return opLog.slice(start).map(({ device_id, seq }) => ({ device_id, seq }))
}

/**
 * Every refusal `apply_page_source` makes, checked before anything is written:
 * a stale base unless `merge` folds the page's changes into the buffer, a page
 * that does not read back as its own source, `lineIds` that are not one per
 * line, front matter it cannot read or a value in it `set_property` refuses
 * (#5160 S8), a property line of a Document buffer `set_property` refuses,
 * and a delete that would take a nested page with it. Returns the
 * buffer's bullets, the page's text per id as it reads back, the rendered ids
 * the buffer left out, what the front matter writes and the warnings.
 */
function readSourceEdit(
  pageId: string,
  source: string,
  baseSource: string,
  flags: { merge: boolean; lineIds: ReadonlyArray<string | null>; grammar: BufferGrammar },
): {
  t1: SourceBullet[]
  before: Map<string | null, string>
  absent: string[]
  front: FrontMatterWrites
  warnings: string[]
} {
  const { grammar } = flags
  const current = grammar.render(pageId)
  const stale = current.source !== baseSource
  if (stale && !flags.merge) {
    throw appErrorRejection({
      kind: 'validation',
      code: 'RequiresRefresh',
      message: `page '${pageId}' changed since its source was loaded`,
    })
  }
  // The page's own source is read as the text the buffer gives of it.
  const now = readFrontMatter(current.source)
  const t0 = readOwnText(now.body, grammar)
  if (t0.length !== current.ids.length || t0.some((b, i) => b.anchor !== current.ids[i])) {
    throw validationRejection(`page '${pageId}' does not read back as its own source`)
  }
  const before = new Map(t0.map((b) => [b.anchor, b.content]))
  const edited = readFrontMatter(source)
  const from = stale ? readFrontMatter(baseSource) : now
  const front = frontMatterWrites(
    definitionSpaceOf(pageId),
    from.front,
    edited.front,
    now.front,
    edited.lines,
  )
  // An id of the source the edit started from is the page's too, so the merge
  // reads a block the page deleted since as that block.
  const loaded = stale ? readOwnText(from.body, grammar) : t0
  const loadedIds = new Set(loaded.flatMap(({ anchor }) => (anchor === null ? [] : [anchor])))
  const warnings: string[] = []
  const known = new Set([...loadedIds, ...current.ids])
  const typed = readByLine(edited.body, flags.lineIds, known, warnings, grammar)
  const t1 = stale ? mergeSourceBuffer(loaded, t0, typed, warnings) : typed
  const marksOf = (bullets: SourceBullet[]) =>
    new Map(bullets.flatMap((b) => (b.anchor === null || !b.marks ? [] : [[b.anchor, b.marks]])))
  planBufferMarks(
    t1,
    { from: marksOf(loaded), now: marksOf(t0), before },
    definitionSpaceOf(pageId),
  )
  const anchors = new Set(t1.flatMap(({ anchor }) => (anchor === null ? [] : [anchor])))
  const absent = current.ids.filter((id) => !anchors.has(id))
  const absentSet = new Set(absent)
  for (const row of blocks.values()) {
    if (row['block_type'] !== 'page' || row['deleted_at']) continue
    if (absentSet.has(row['parent_id'] as string)) {
      throw validationRejection(`deleting its parent would delete the page '${String(row['id'])}'`)
    }
  }
  return { t1, before, absent, front, warnings }
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
  // The backend creates these content blocks below the command layer, with no
  // scope; the mock reuses the `create_block` command, so it hands it the page's.
  const scope = { kind: 'active', space_id: ownerSpaceOf({ id: pageId }) }
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
            scope,
          })
          id = row.id
          opRefs.push(...row.op_refs)
          if (bullet.writes) opRefs.push(...writeMarks(row.id, bullet.writes))
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

/**
 * Whether an import writes `key:: value` as a property rather than keeping it
 * as text (#5160 D11), for what the mock models: the value `set_property`
 * accepts (a select option, a valid repeat rule), or a priority letter, which
 * the import reads as the option it stands for (`import_priority_value`).
 */
function importKeepsProperty(spaceId: string, key: string, value: string): boolean {
  if (key === 'priority' && /^[ABC]$/.test(value)) return true
  try {
    assertValidSetPropertyValue(spaceId === '' ? null : spaceId, key, value)
    return true
  } catch {
    return false
  }
}

/** The primitives `PAGES_ALLOWED_KEYS` admits (`agaric-store/src/filters/primitive.rs`). */
const PAGES_PRIMITIVE_TYPES: ReadonlySet<string> = new Set([
  'Tag',
  'TagOrRef',
  'PathGlob',
  'HasProperty',
  'LastEdited',
  'Space',
  'Priority',
  'Orphan',
  'Stub',
  'HasNoInboundLinks',
])

export const pagesHandlers = {
  // Indexed lookup for a single date-formatted journal page in
  // the active space. Real backend implementation: a SELECT on
  // `idx_blocks_journal_date` scoped on `blocks.space_id`.
  get_journal_page_by_date: (args) => {
    const a = args as Record<string, unknown>
    const date = a['date'] as string
    const spaceId = readActiveSpaceScope('get_journal_page_by_date', a)
    for (const b of blocks.values()) {
      if (b['block_type'] !== 'page') continue
      if (b['deleted_at']) continue
      if (b['content'] !== date) continue
      if (ownerSpaceOf(b) !== spaceId) continue
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
    const spaceId = readActiveSpaceScope('list_journal_pages_in_range', a)
    assertValidDateFormat(startDate)
    assertValidDateFormat(endDate)
    if (startDate > endDate) throw validationRejection('start_date must be <= end_date')
    const datePattern = /^\d{4}-\d{2}-\d{2}$/
    const items: Record<string, unknown>[] = []
    for (const b of blocks.values()) {
      if (b['block_type'] !== 'page') continue
      if (b['deleted_at']) continue
      const content = b['content'] as string | null
      if (!content || !datePattern.test(content)) continue
      if (content < startDate || content > endDate) continue
      if (ownerSpaceOf(b) !== spaceId) continue
      items.push(b)
    }
    // `datePattern` admits only `NNNN-NN-NN`, so every compare resolves on a
    // digit pair — where ICU and SQLite's BINARY agree and `localeCompare` is safe.
    items.sort((x, y) =>
      ((x['content'] as string) ?? '').localeCompare((y['content'] as string) ?? ''),
    )
    return items
  },

  // Every page in the active space as a `PageHeading`.  No pagination,
  // no clamp — bounded by the space's intrinsic page count.  Backs
  // `exportGraphAsZip` and graph rendering.
  //
  // `tagIds`, when non-empty, restricts the result to pages carrying at
  // least one of those tags via the direct `block_tags` table (mock
  // models direct tags only — same surface as the real backend's
  // direct-tag filter; inherited tags intentionally not modelled here).
  list_all_pages_in_space: (args) => {
    const a = args as Record<string, unknown>
    const spaceId = readActiveSpaceScope('list_all_pages_in_space', a)
    const rawTagIds = a['tagIds'] as string[] | null | undefined
    assertTagFilterWithinCap(rawTagIds)
    const tagFilter = rawTagIds && rawTagIds.length > 0 ? new Set(rawTagIds) : null
    const items: PageHeading[] = []
    for (const b of blocks.values()) {
      if (b['block_type'] !== 'page') continue
      if (b['deleted_at']) continue
      if (ownerSpaceOf(b) !== spaceId) continue
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
      items.push({
        id: b['id'] as string,
        content: (b['content'] as string | null) ?? null,
        todo_state: (b['todo_state'] as string | null) ?? null,
        priority: (b['priority'] as string | null) ?? null,
        due_date: (b['due_date'] as string | null) ?? null,
        scheduled_date: (b['scheduled_date'] as string | null) ?? null,
      })
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
    const spaceId = readActiveSpaceScope('load_page_subtree', a)
    // Space-membership check — mirrors the backend.
    if (ownerSpaceOf(blocks.get(rootBlockId) ?? { id: rootBlockId }) !== spaceId) {
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
    // #5243 — a trashed root is `not_found`, checked after the space.
    if (blocks.get(rootBlockId)?.['deleted_at']) {
      throw notFoundRejection('page is in the trash')
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
    // The backend's serde refuses an unknown sort before the command runs.
    if (!isPageSort(sort)) throw validationRejection(`unknown variant \`${sort}\``)
    const cursor = a['cursor'] as string | null
    const limit = listPagesWithMetadataLimit(a['limit'])
    const rows = pageSortRows(spaceId)

    // Phase 3 — AND-compose the requested filter primitives, then sort.
    const filters = (filter['filters'] as Array<Record<string, unknown>> | undefined) ?? []
    // `validate_pages_filters`: refuse an off-surface primitive before any row is read.
    for (const f of filters) {
      if (!PAGES_PRIMITIVE_TYPES.has(f['type'] as string)) {
        throw appErrorRejection({
          kind: 'validation',
          code: 'InvalidFilter',
          message: `\`${String(f['type'])}\` is not a valid filter on the Pages surface`,
        })
      }
    }
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

  // #5371 — `record_page_open_inner`: stamp a live page as opened now, on
  // this device only (no op); anything else is `NotFound`.
  record_page_open: (args) => {
    const pageId = (args as Record<string, unknown>)['pageId'] as string
    const page = blocks.get(pageId)
    if (page?.['block_type'] !== 'page' || page['deleted_at']) {
      throw notFoundRejection(`page ${pageId}`)
    }
    pageOpens.set(pageId, Date.now())
    return null
  },

  // Every page in the space whose `template` property is set to 'true'.
  // No pagination, no clamp; the graph view uses this to flag templates.
  list_template_page_ids_in_space: (args) => {
    const a = args as Record<string, unknown>
    const spaceId = readActiveSpaceScope('list_template_page_ids_in_space', a)
    const ids: string[] = []
    for (const b of blocks.values()) {
      if (b['block_type'] !== 'page') continue
      if (b['deleted_at']) continue
      if (ownerSpaceOf(b) !== spaceId) continue
      const tplProp = properties.get(b['id'] as string)?.get('template')
      if (tplProp?.['value_text'] !== 'true') continue
      ids.push(b['id'] as string)
    }
    return ids
  },

  list_undated_tasks: (args) => {
    // Honour `scope: SpaceScope` (mirrors
    // `list_undated_tasks_inner`).
    const a = (args ?? {}) as Record<string, unknown>
    const spaceId = readActiveSpaceScope('list_undated_tasks', a)
    const items = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
      if (b['todo_state'] === null) return false
      if (b['due_date'] !== null) return false
      if (b['scheduled_date'] !== null) return false
      if (ownerSpaceOf(b) !== spaceId) return false
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
  // `SpaceSwitcher`'s `Alt+1`..`Alt+9` hotkeys index into this order, so a
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
    return createPageInSpace(
      (a['parentId'] as string | null) ?? null,
      (a['content'] as string) ?? null,
      (a['spaceId'] as string | null) ?? null,
    )
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
    // #5841 — a new space starts with the default definitions, not a copy of
    // another space's.
    seedDefaultPropertyDefs(id, new Date().toISOString())
    return id
  },

  set_page_aliases: (args) => {
    const a = args as Record<string, unknown>
    const pid = a['pageId'] as string
    const wanted = wantedAliases(a['aliases'] as string[])
    requireLivePage(pid)
    // `set_page_aliases_inner` refuses the whole edit, nothing written, when
    // another page holds one of the aliases.
    const taken = aliasEdit(pid, wanted).added.find((alias) => aliasHolder(alias, pid) !== null)
    if (taken !== undefined) {
      throw appErrorRejection({
        kind: 'validation',
        code: 'DuplicatePageAlias',
        message: `alias '${taken}' is already used by another page`,
      })
    }
    return { aliases: wanted, op_refs: writePageAliases(pid, wanted).opRefs }
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
    // alias pointing at a foreign-space page does not surface.
    const spaceId = readActiveSpaceScope('resolve_page_by_alias', a)
    for (const [pid, aliases] of pageAliases.entries()) {
      if (aliases.some((al) => foldAsciiUppercase(al) === alias)) {
        const page = blocks.get(pid)
        if (!page) continue
        // `b.deleted_at IS NULL`: a soft-deleted page keeps its alias rows
        // (only a purge cascades them) but stops resolving.
        if (page['deleted_at']) continue
        // `b.space_id = ?`, the #533 column.
        if (page['space_id'] !== spaceId) continue
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
    const spaceId = readActiveSpaceScope('list_page_aliases_by_prefix', a)

    const rows: Array<[string, string, string | null]> = []
    for (const [pid, aliases] of pageAliases.entries()) {
      const page = blocks.get(pid)
      if (!page) continue
      if (page['deleted_at']) continue
      // `b.space_id = ?`, the #533 column.
      if (page['space_id'] !== spaceId) continue
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
      // Like the backend's `push_block_bullet`: the lines after the first
      // are indented under the bullet, so a fence's tab stays code.
      const [head, ...rest] = ((child['content'] as string | null) ?? '').split('\n')
      md += `- ${head}${rest.map((line) => `\n  ${line}`).join('')}\n`
    }
    return md
  },

  get_page_source: (args) =>
    renderPageSource((args as Record<string, unknown>)['pageId'] as string).source,

  // #5160 A — the same buffer with each block's id beside its text: the mock's
  // render less its anchors ({@link anchorFree}), in the dialect asked for,
  // Source when none (#5691).
  get_page_buffer: (args) => {
    const a = args as Record<string, unknown>
    const grammar = grammarOf(a)
    const { source } = grammar.render(a['pageId'] as string)
    const { text, lineIds } = grammar.anchorFree(source)
    return { source, text, line_ids: lineIds }
  },

  // #5140 Phase 4a — save the page edited as its source buffer: moves and
  // creates first, then edits, then the page's front matter (#5160 S8), then
  // deletes, so a child kept out of a deleted block has moved before the
  // delete cascades. The text is read by `readByLine`; in a Source buffer the
  // backend's list markers, task checkboxes and property lines are not
  // modelled (`properties_*` count the page's own), nor in either dialect are
  // its op cap and depth limit; tests must not rely on the mock for them. The
  // names a new or edited bullet writes resolve in the page's space
  // (`resolveInboundNames`, #5160 N4), the created pages and tags in
  // `names_created`. Phase 5: with `merge`, a stale buffer is saved with the
  // page's changes folded in (`mergeSourceBuffer`).
  // #5691: a Document buffer is rendered and read as the backend's grammar
  // writes and reads it, and its save writes a block's list marker, checkbox
  // and `key:: value` lines as the backend does: `listStyle`, the task state
  // and each property, by key, a task's hidden list style going with an edit
  // to it (`planMarkWrites`); a merge forks a block whose property both sides
  // changed. Not modelled: a key folded to its definition (D13), a `key::`
  // line with no value for a key the block does not hold (kept as text
  // there), a number or boolean its definition refuses, and the page's own
  // `key:: value` lines after its front matter.
  apply_page_source: (args) => {
    const a = args as Record<string, unknown>
    const pageId = a['pageId'] as string
    const edit = readSourceEdit(pageId, a['source'] as string, a['baseSource'] as string, {
      merge: a['merge'] === true,
      lineIds: a['lineIds'] as Array<string | null>,
      grammar: grammarOf(a),
    })
    const report = { created: 0, edited: 0, moved: 0, deleted: 0 }
    const opRefs: OpRefs = []
    const namesCreated: Record<string, unknown>[] = []
    const page = blocks.get(pageId)
    const spaceId = page ? ((page['space_id'] as string | null) ?? ownerSpaceOf(page)) : null
    if (spaceId !== null) {
      const written = edit.t1.filter(
        ({ anchor, content }) => anchor === null || content !== edit.before.get(anchor),
      )
      const names = resolveInboundNames(
        written.map(({ content }) => content),
        spaceId,
        opRefs,
      )
      written.forEach((bullet, i) => {
        bullet.content = names.contents[i] as string
      })
      namesCreated.push(...names.created)
      edit.warnings.push(...names.warnings)
    }
    opRefs.push(...placeSourceBullets(pageId, edit.t1, report))
    const marks = { set: 0, deleted: 0 }
    for (const { anchor, content, writes } of edit.t1) {
      if (anchor === null) continue
      if (content !== edit.before.get(anchor) && content !== blocks.get(anchor)?.['content']) {
        opRefs.push(...blocksHandlers.edit_block({ blockId: anchor, toText: content }).op_refs)
        report.edited += 1
      }
      if (writes === undefined) continue
      opRefs.push(...writeMarks(anchor, writes))
      const state = writes.todoState?.to
      marks.set += writes.set.length + (state ? 1 : 0)
      marks.deleted += writes.deleted.length + (state === null ? 1 : 0)
    }
    const written = writeFrontMatter(pageId, edit.front, spaceId, {
      opRefs,
      namesCreated,
      warnings: edit.warnings,
    })
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
      properties_set: written.properties_set + marks.set,
      properties_deleted: written.properties_deleted + marks.deleted,
      names_created: namesCreated,
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
  // contract lives in `agaric-engine/src/import.rs` (`parse_logseq_markdown`)
  // and `src-tauri/src/commands/pages/markdown.rs` (`import_markdown_with_progress`
  // / `folder_path_to_namespace_title`). This handler does NOT reimplement that
  // parser — it deliberately models a faithful *subset* of the backend so the
  // dev-preview UI (progress bar, warnings panel, "N properties" branch) is
  // exercised, while never *accepting more structure than the backend does*.
  //
  // It intentionally aligns with the backend on the things tests can assert:
  //   - Title: derived from the filename/folder path the same way the backend
  //     does (strip `.md`, normalise `\`→`/`, drop empty segments, rejoin with
  //     `/`), falling back to "Imported Page". A leading `# heading` equal to
  //     that title is the title, not a block (#5160 S6); any other heading is
  //     ordinary content.
  //   - Blocks: the mock's block grammar (`parseOutline` in blocks.ts): one
  //     block per list item of any marker, heading and paragraph, a checkbox
  //     after the marker as the block's `todo_state` (#5160 D6).
  //   - Names: `[[Page]]` and `#tag` resolve in the target space through
  //     `resolveInboundNames` (#5160 N4), and a file whose title names an
  //     empty page of the space fills that page (D12).
  //
  // It intentionally does NOT model (and tests MUST NOT rely on the mock for
  // any of these — the Rust tests own the import contract):
  //   - Frontmatter / inline `key:: value` properties beyond a raw COUNT
  //     (`properties_set`); no property values are stamped onto blocks.
  //   - `((block-ref))` stripping, `[[Page#anchor]]` block targets and
  //     Obsidian `![[Note]]` embeds.
  //   - Depth: every content block is emitted flat under the page.
  //   - Attachment handling (kept as literal text).
  //   - A folder pick's note names (`vault.notes`, #5740): a bare `[[Name]]`
  //     resolves as `Name`, never as the vault's note of that name.
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
    // normalise `\`→`/`, drop empty segments, rejoin with `/`. Fall back to
    // "Imported Page" when nothing usable remains, matching markdown.rs:884.
    const namespaceTitle = (filename ?? '')
      .replace(/\.md$/i, '')
      .replace(/\\/g, '/')
      .split('/')
      .map((seg) => seg.trim())
      .filter((seg) => seg.length > 0)
      .join('/')
    const pageTitle = namespaceTitle.length > 0 ? namespaceTitle : 'Imported Page'
    // A leading `# Title` equal to the derived title is dropped, as the
    // backend's `strip_title_heading` does (#5160 S6).
    const lines = content.split('\n')
    const first = lines[0]?.replace(/\r$/, '') ?? ''
    if (first.startsWith('# ') && first.slice(2).trim() === pageTitle) lines.shift()

    // Faithful-but-simple property count: the real importer pulls properties
    // from YAML frontmatter and inline `key:: value` lines. We don't reproduce
    // the parser — we just count the `key:: value` lines it would write, so the
    // result panel's "N properties" branch is exercised in dev-preview rather
    // than hardcoded to 0. (Frontmatter and `#tag` parsing are intentionally
    // NOT modelled here.)
    const propertiesSet = lines.filter((line) => {
      const match = /^\s*([^\s:][^:]*)::\s+(\S.*)$/.exec(line)
      return match !== null && importKeepsProperty(spaceId, match[1] ?? '', (match[2] ?? '').trim())
    }).length

    // Create the page block in the space, unless an empty page of the space
    // already carries the title (#5160 D12).
    const adopted = spaceId ? findEmptyPageTitled(pageTitle, spaceId) : null
    const pageId = adopted ?? fakeId()
    if (adopted === null) {
      blocks.set(pageId, {
        ...makeBlock(pageId, 'page', pageTitle, null, blocks.size),
        space_id: spaceId === '' ? null : spaceId,
      })
    }

    // Pre-compute the content blocks so we know `blocks_total` before emitting
    // `started` (the real backend reports the parser's count up front so the UI
    // can render a determinate bar from the very first event).
    const parsed = parseOutline(lines.join('\n'))
    const parsedLines = parsed.map((block) => block.content)
    const blocksTotal = parsedLines.length

    emit({ kind: 'started', page_title: pageTitle, blocks_total: blocksTotal })

    // Representative non-empty warning so the result panel's warning UI is
    // exercised in dev-preview. Mirrors the shape of a real parse-time
    // diagnostic (attachments are not modelled; their refs stay literal text).
    const warnings: string[] = [
      'dev-preview mock: attachments are not imported (kept as literal text)',
    ]
    const names = spaceId ? resolveInboundNames(parsedLines, spaceId, []) : null
    const contentLines = names?.contents ?? parsedLines
    warnings.push(...(names?.warnings ?? []))

    let blocksCreated = 0
    let position = 0
    for (const [i, trimmed] of contentLines.entries()) {
      const blockId = fakeId()
      const block = makeBlock(blockId, 'content', trimmed, pageId, position)
      // A checkbox after the bullet is the block's task state (#5160 D6).
      block['todo_state'] = parsed[i]?.todoState ?? null
      blocks.set(blockId, block)
      blocksCreated++
      position++
      emit({ kind: 'progress', blocks_done: blocksCreated, blocks_total: blocksTotal })
    }

    emit({
      kind: 'complete',
      page_title: pageTitle,
      blocks_created: blocksCreated,
      properties_set: propertiesSet,
    })

    // The mock reads no Logseq `collapsed::` line, so it folds nothing, and no
    // anchor, so it leaves no reference for `link_import_anchors`.
    return {
      page_title: pageTitle,
      page_id: pageId,
      blocks_created: blocksCreated,
      properties_set: propertiesSet,
      collapsed: [],
      warnings,
      anchors: [],
      deferred: [],
    }
  },

  // The end of a folder import. The mock's import defers no reference, so
  // there is nothing to link; the Rust tests own the contract.
  link_import_anchors: () => [],

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

    // #2463 — `require_live_space_in_tx`.
    if (!isLiveSpace(spaceId)) {
      throw validationRejection(
        `space_id '${spaceId}' does not refer to a live space block (is_space = 'true')`,
      )
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
      blocks.set(pageId, {
        ...makeBlock(pageId, 'page', `Reference ${i + 1}`, null, blocks.size),
        space_id: spaceId,
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
  | 'record_page_open'
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
  | 'get_page_buffer'
  | 'apply_page_source'
  | 'get_blocks_source'
  | 'import_markdown'
  | 'link_import_anchors'
  | 'import_bibliography'
>
