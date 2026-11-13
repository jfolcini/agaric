import { format as formatDateFns, addDays, getISOWeek } from 'date-fns'

import { substituteTemplateVariables, toDateFnsPattern } from '@/editor/template-variables'
import { unwrap } from '@/lib/app-error'
import type { BlockRow, CreateBlockSpec, OpRef, PropertyRow, SetPropertyArgs } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { getDateLocale } from '@/lib/date-locale'
import { INLINE_PROPERTY_RESERVED_KEYS } from '@/lib/inline-property-parse'
import { logger } from '@/lib/logger'
import { PREFERENCES, readPreference, writePreference } from '@/lib/preferences'
import { paginationLimit } from '@/lib/safe-limit'
import { requireActiveScope } from '@/lib/space-scope'

/**
 * Load all pages marked as templates (property `template` = 'true').
 *
 * `spaceId` — the active space; `null` (store not hydrated) returns no
 * templates without dispatching (#5415).
 *
 * `blockType: 'page'` is pushed into SQL via
 * Tier 3.4's `query_by_property` push-down filter. The previous
 * JS-side `b.block_type === 'page'` filter wasted bandwidth on
 * non-page rows that the backend now drops at query time.
 */
export async function loadTemplatePages(spaceId: string | null): Promise<BlockRow[]> {
  if (spaceId == null) return []
  const resp = unwrap(
    await commands.queryByProperty(
      {
        key: 'template',
        valueText: 'true',
        valueDate: null,
        operator: null,
        cursor: null,
        limit: paginationLimit(100),
        excludeParentId: null,
        contentNonEmpty: null,
        blockType: 'page',
        valueTextIn: null,
        valueDateRange: null,
        excludeTodoStates: null,
      },
      requireActiveScope(spaceId),
    ),
  )
  return resp.items
}

/**
 * Load the journal template page (property `journal-template` = 'true').
 * Returns the first matching page (or null) and an optional warning when
 * multiple journal templates are found so the caller can surface it to the user.
 *
 * `spaceId` — the active space; `null` (store not hydrated) returns no
 * template without dispatching (#5415).
 *
 * `blockType: 'page'` is pushed into SQL so non-page
 * rows are dropped at query time rather than via a JS-side filter.
 */
export async function loadJournalTemplate(spaceId: string | null): Promise<{
  template: BlockRow | null
  duplicateWarning: string | null
}> {
  if (spaceId == null) return { template: null, duplicateWarning: null }
  const resp = unwrap(
    await commands.queryByProperty(
      {
        key: 'journal-template',
        valueText: 'true',
        valueDate: null,
        operator: null,
        cursor: null,
        limit: paginationLimit(10),
        excludeParentId: null,
        contentNonEmpty: null,
        blockType: 'page',
        valueTextIn: null,
        valueDateRange: null,
        excludeTodoStates: null,
      },
      requireActiveScope(spaceId),
    ),
  )
  const pages = resp.items
  const duplicateWarning =
    pages.length > 1
      ? `Multiple journal templates found (${pages.length}). Using "${pages[0]?.content ?? pages[0]?.id}". ` +
        'Remove the journal-template property from extra pages to avoid ambiguity.'
      : null
  return { template: pages[0] ?? null, duplicateWarning }
}

/**
 * Load template pages with a preview of their first child's content.
 * Returns the page data plus a truncated preview string.
 *
 * `spaceId` (Phase 4) — when set, restricts templates to the
 * active space.
 *
 * Collapses the previous N+1
 * (`listBlocks({ parentId, limit: 1 })` per template) into a single
 * `firstChildForBlocks(allTemplateIds)` IPC. Templates with no
 * children, with a fetch failure, or absent from the response map
 * surface a `null` preview (best-effort, mirroring the prior shape).
 */
export async function loadTemplatePagesWithPreview(
  spaceId: string | null,
): Promise<Array<{ id: string; content: string; preview: string | null }>> {
  const pages = await loadTemplatePages(spaceId)
  if (pages.length === 0) return []

  let firstChildren: Record<string, BlockRow> = {}
  try {
    firstChildren = unwrap(await commands.firstChildForBlocks(pages.map((p) => p.id)))
  } catch (err) {
    // Preview is best-effort — log and fall through; every page surfaces
    // a `null` preview, matching the per-template per-error shape that
    // the prior loop produced.
    logger.warn(
      'template-utils',
      'template preview batch fetch failed',
      { templateCount: pages.length },
      err,
    )
  }

  return pages.map((page) => {
    const child = firstChildren[page.id]
    let preview: string | null = null
    if (child) {
      const text = child.content ?? ''
      preview = text.length > 60 ? `${text.slice(0, 60)}…` : text
    }
    return { id: page.id, content: page.content ?? '', preview }
  })
}

/**
 * #1450 Phase 1 — context handed to every legacy `<% %>` resolver.
 *
 * `now` is injectable purely for deterministic tests (mirrors the #1442
 * `{{ }}` `TemplateVariableContext.now`); production always omits it so each
 * insertion reflects the real clock.
 */
export interface LegacyTemplateContext {
  /** Title of the page the template is being inserted into. */
  pageTitle?: string
  /** Injectable "now" for tests. Defaults to `new Date()` at call time. */
  now?: Date
}

/** A resolver turns the matched `<% %>` body's argument into its substitution. */
type LegacyResolver = (arg: string | null, now: Date, ctx: LegacyTemplateContext) => string

/**
 * Format `date` with a user-supplied format string, falling back to
 * `fallback` (verbatim, never throwing) when the format is empty or invalid.
 */
function formatWithFallback(date: Date, userFormat: string | null, fallback: string): string {
  if (userFormat == null || userFormat.length === 0) return fallback
  try {
    // #4555 — a user FORMAT string can carry textual month/weekday tokens
    // (`<% today: MMMM d, yyyy %>`), so it must resolve through the same
    // single locale point as every other date-fns call.
    const out = formatDateFns(date, toDateFnsPattern(userFormat), {
      locale: getDateLocale(),
    })
    // `date-fns/format` can return '' for a pathological pattern; treat that
    // as a failure and fall back so a token never silently vanishes.
    return out.length > 0 ? out : fallback
  } catch {
    return fallback
  }
}

/**
 * Build the legacy default-format strings exactly as the original
 * `.replace()` chain did (raw local-time string building — NOT `date-fns`)
 * so the four pre-existing tokens stay byte-for-byte unchanged.
 */
function legacyDefaults(now: Date): {
  today: string
  time: string
  datetime: string
} {
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const hh = String(now.getHours()).padStart(2, '0')
  const min = String(now.getMinutes()).padStart(2, '0')
  return {
    today: `${yyyy}-${mm}-${dd}`,
    time: `${hh}:${min}`,
    datetime: `${yyyy}-${mm}-${dd} ${hh}:${min}`,
  }
}

/**
 * Token → resolver map for the legacy `<% %>` template system (#1450 Phase 1).
 *
 * Each entry's key is the lower-cased token name (whitespace inside the
 * token name is collapsed to a single space before lookup, so `<% page  title %>`
 * still matches `page title`). The resolver receives the optional `:FORMAT`
 * argument (or `null`), the resolved `now`, and the insertion context.
 *
 * Phase 1 deliberately leaves the separate `{{ }}` grammar
 * (`substituteTemplateVariables`) untouched — the two systems coexist by
 * design.
 */
const LEGACY_RESOLVERS: Readonly<Record<string, LegacyResolver>> = {
  // --- The four pre-existing tokens. Bare form is byte-unchanged. ---
  today: (arg, now) => formatWithFallback(now, arg, legacyDefaults(now).today),
  time: (arg, now) => formatWithFallback(now, arg, legacyDefaults(now).time),
  datetime: (arg, now) => formatWithFallback(now, arg, legacyDefaults(now).datetime),
  'page title': (_arg, _now, ctx) => ctx.pageTitle ?? '',

  // --- New built-ins (#1450 Phase 1). ---
  weekday: (arg, now) =>
    formatWithFallback(now, arg, formatDateFns(now, 'EEEE', { locale: getDateLocale() })),
  month: (arg, now) =>
    formatWithFallback(now, arg, formatDateFns(now, 'MMMM', { locale: getDateLocale() })),
  isoweek: (_arg, now) => String(getISOWeek(now)),
}

/**
 * Resolve a single `<% %>` token body to its substitution, or `null` when the
 * token is unknown (so the caller passes it through verbatim).
 *
 * Handles three families:
 *  - `name` / `name:FORMAT` — looked up in `LEGACY_RESOLVERS`.
 *  - `date+N` / `date-N` (optionally `:FORMAT`) — date math relative to today.
 */
function resolveLegacyToken(body: string, now: Date, ctx: LegacyTemplateContext): string | null {
  // Collapse internal whitespace so `page  title` === `page title`.
  const normalized = body.trim().replace(/\s+/g, ' ')

  // Split off an optional `:FORMAT` on the FIRST colon so the format may
  // itself contain colons (e.g. a `HH:mm` time format).
  const colonIdx = normalized.indexOf(':')
  const head = (colonIdx === -1 ? normalized : normalized.slice(0, colonIdx)).trim()
  const arg = colonIdx === -1 ? null : normalized.slice(colonIdx + 1).trim()

  // Date math: `date+N` / `date-N` (days relative to today), optionally
  // combined with a `:FORMAT`. Invalid offset → not a date-math token.
  const mathMatch = /^date([+-])(\d+)$/i.exec(head)
  if (mathMatch) {
    const sign = mathMatch[1] === '-' ? -1 : 1
    const days = sign * Number.parseInt(mathMatch[2] as string, 10)
    const target = addDays(now, days)
    return formatWithFallback(target, arg, legacyDefaults(target).today)
  }

  const resolver = LEGACY_RESOLVERS[head.toLowerCase()]
  if (resolver) return resolver(arg, now, ctx)

  return null
}

/**
 * Expand template variables in content (legacy `<% %>` system, #1450 Phase 1).
 *
 * Built on a token → resolver map (`LEGACY_RESOLVERS` + `resolveLegacyToken`)
 * rather than a hardcoded `.replace()` chain.
 *
 * Supported variables:
 * - `<% today %>` / `<% today:FORMAT %>` → current date (default `YYYY-MM-DD`)
 * - `<% time %>` / `<% time:FORMAT %>` → current time (default `HH:MM`)
 * - `<% datetime %>` / `<% datetime:FORMAT %>` → date+time (default `YYYY-MM-DD HH:MM`)
 * - `<% page title %>` → title of the target page
 * - `<% date+N %>` / `<% date-N %>` (optionally `:FORMAT`) → today ± N days
 * - `<% weekday %>` → full day name (e.g. `Monday`)
 * - `<% month %>` → full month name (e.g. `June`)
 * - `<% isoweek %>` → ISO week number
 *
 * `FORMAT` uses `date-fns` tokens with the `{{date:FORMAT}}` Moment-token
 * mapping (see `toDateFnsPattern`). An invalid format falls
 * back to the default and never throws. Unknown tokens pass through verbatim.
 *
 * NOTE: this is the LEGACY system; the `{{ }}` grammar
 * (`substituteTemplateVariables`) is separate and intentionally not unified.
 */
export function expandTemplateVariables(content: string, context: LegacyTemplateContext): string {
  const now = context.now ?? new Date()
  // Match `<% ... %>`; the body is lazy so adjacent tokens don't merge.
  return content.replace(/<%([^]*?)%>/g, (whole, body: string) => {
    const resolved = resolveLegacyToken(body, now, context)
    // Unknown token → passthrough verbatim (don't drop it).
    return resolved === null ? whole : resolved
  })
}

/** A block reading `<% recording %>`, as `is_recording_placeholder` (Rust) reads it. */
function isRecordingPlaceholder(content: string): boolean {
  const m = /^<%([\s\S]*)%>$/.exec(content.trim())
  return m?.[1]?.trim().toLowerCase() === 'recording'
}

/**
 * The task state, priority and dates of a template block, and its properties
 * the copy keeps (the app's stamps and the template marker are not): text
 * values as `create_blocks_batch`'s `properties`, values held as a number,
 * date, ref or boolean as its `typedProperties`.
 */
function copiedProperties(
  block: BlockRow,
  rows: readonly PropertyRow[],
): Pick<CreateBlockSpec, 'properties' | 'typedProperties'> {
  const properties: Record<string, string> = {}
  const typedProperties: Record<string, SetPropertyArgs> = {}
  for (const key of ['todo_state', 'priority', 'due_date', 'scheduled_date'] as const) {
    const value = block[key]
    if (value != null) properties[key] = value
  }
  for (const row of rows) {
    if (INLINE_PROPERTY_RESERVED_KEYS.has(row.key)) continue
    if (row.value_text != null) properties[row.key] = row.value_text
    else {
      const { value_num, value_date, value_ref, value_bool } = row
      const bool = value_bool == null ? null : value_bool !== 0
      typedProperties[row.key] = { value_num, value_date, value_ref, value_bool: bool }
    }
  }
  return { properties, typedProperties }
}

/**
 * Insert a template's blocks under the given parent, after its last child:
 * content, task state, priority, dates, properties, order and nesting, in one
 * `create_blocks_batch` (one transaction: all of it lands or none of it, and a
 * failure rejects).
 *
 * Template variables are expanded during insertion: the legacy
 * `<% today %>` family AND the #1442 `{{date}}`/`{{date:FORMAT}}`/`{{time}}`/
 * `{{title}}` grammar (see `src/editor/template-variables.ts`). A
 * `{{cursor}}` marker in a block records the caret target: it is stripped
 * from the content and, when `context.onCursorBlock` is supplied, the
 * created block's id is reported back so the caller can focus it after the
 * template lands. `context.onOpRefs` receives the refs of the insert, once,
 * so the caller can record it as one undo step. Returns the IDs of all
 * created blocks.
 *
 * The template subtree arrives in one `loadPageSubtree` call. The specs are
 * built depth-first, so a nested block names its parent by that parent's
 * index in the batch.
 */
export async function insertTemplateBlocks(
  templatePageId: string,
  parentId: string,
  spaceId: string | null,
  context?: {
    pageTitle?: string
    onCursorBlock?: (blockId: string) => void
    onOpRefs?: (refs: OpRef[]) => void
  },
): Promise<string[]> {
  // Templates belong to a single space, so the descendant fetch
  // (`loadPageSubtree`) is required-active (b1). With no active space
  // there is no template to expand, so short-circuit to "no blocks
  // inserted" instead of dispatching a Global scope the backend rejects.
  // In practice `insertTemplateBlocks` is only reached via user action
  // after bootstrap, so this guard should never fire.
  if (spaceId == null) {
    logger.warn('template-utils', 'insertTemplateBlocks: no active space; skipping', {})
    return []
  }

  // #1258 — `loadPageSubtree` returns `{ blocks, truncated, total }`.
  // Templates are authored, small subtrees, so truncation is not expected
  // here; take the blocks array.
  const descendants = unwrap(
    await commands.loadPageSubtree(templatePageId, requireActiveScope(spaceId)),
  ).blocks
  const propertiesById =
    descendants.length === 0
      ? {}
      : unwrap(await commands.getBatchProperties(descendants.map((b) => b.id)))
  // `load_page_subtree` documents its row order as not load-bearing, so the
  // copy orders each sibling group by position itself.
  const childrenByParent = new Map<string, BlockRow[]>()
  for (const block of descendants) {
    const pid = block.parent_id
    if (pid == null) continue
    const siblings = childrenByParent.get(pid)
    if (siblings) siblings.push(block)
    else childrenByParent.set(pid, [block])
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort(
      (a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER),
    )
  }

  const specs: CreateBlockSpec[] = []
  // The index of the first block that carried a `{{cursor}}` marker.
  let cursorIndex: number | null = null

  function walkChildren(sourceParentId: string, destParentIndex: number | null): void {
    for (const child of childrenByParent.get(sourceParentId) ?? []) {
      // The placeholder marks where `/meeting` puts the recording; a plain
      // insert has no recording, so its children take its place.
      if (isRecordingPlaceholder(child.content ?? '')) {
        walkChildren(child.id, destParentIndex)
        continue
      }
      // Two-stage expansion: legacy `<% %>` first, then the #1442 `{{ }}`
      // grammar (which also strips any `{{cursor}}` marker and reports it).
      const legacyExpanded = expandTemplateVariables(child.content ?? '', context ?? {})
      const { text, hasCursor } = substituteTemplateVariables(
        legacyExpanded,
        context?.pageTitle === undefined ? {} : { pageTitle: context.pageTitle },
      )
      const index = specs.length
      if (hasCursor && cursorIndex === null) cursorIndex = index
      specs.push({
        blockType: 'content',
        content: text,
        parentId: destParentIndex == null ? parentId : null,
        parentIndex: destParentIndex,
        position: null,
        ...copiedProperties(child, propertiesById[child.id] ?? []),
      })
      walkChildren(child.id, index)
    }
  }

  walkChildren(templatePageId, null)
  if (specs.length === 0) return []

  const { blocks: created, op_refs } = unwrap(await commands.createBlocksBatch(specs))
  context?.onOpRefs?.(op_refs)
  const ids = created.map((row) => row.id)
  if (cursorIndex !== null) {
    const cursorId = ids[cursorIndex]
    if (cursorId !== undefined) context?.onCursorBlock?.(cursorId)
  }
  return ids
}

const SPACE_TEXT_JOURNAL_TEMPLATE_KEY = 'journal_template'

/**
 * #5373 — delete the retired per-space text journal templates once per device.
 *
 * Ordinary `DeleteProperty` ops rather than a SQL migration: property state
 * lives in the op log and Loro, which a migration editing `block_properties`
 * would skip. Marked done only after every delete lands, so a failure is
 * retried on the next boot.
 */
export async function deleteSpaceTextJournalTemplates(spaceIds: string[]): Promise<void> {
  if (readPreference(PREFERENCES.spaceTextJournalTemplatesDeleted)) return
  try {
    const propertiesBySpace = unwrap(await commands.getBatchProperties(spaceIds))
    for (const spaceId of spaceIds) {
      const properties = propertiesBySpace[spaceId] ?? []
      if (properties.some((p) => p.key === SPACE_TEXT_JOURNAL_TEMPLATE_KEY)) {
        unwrap(await commands.deleteProperty(spaceId, SPACE_TEXT_JOURNAL_TEMPLATE_KEY))
      }
    }
    writePreference(PREFERENCES.spaceTextJournalTemplatesDeleted, true)
  } catch (err) {
    logger.warn(
      'template-utils',
      'deleting the per-space text journal templates failed; retrying next boot',
      { spaceIds },
      err,
    )
  }
}
