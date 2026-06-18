import { format as formatDateFns, addDays, getISOWeek } from 'date-fns'

import { substituteTemplateVariables } from '@/editor/template-variables'

import { logger } from './logger'
import type { BlockRow, CreateBlockSpec } from './tauri'
import {
  createBlocksBatch,
  firstChildForBlocks,
  getProperty,
  loadPageSubtree,
  paginationLimit,
  queryByProperty,
} from './tauri'

/**
 * Load all pages marked as templates (property `template` = 'true').
 *
 * `spaceId` (FEAT-3 Phase 4) — when set, restricts templates to the
 * active space. `null` keeps the cross-space (legacy) behaviour.
 *
 * PEND-35 Tier 2.8 — `blockType: 'page'` is pushed into SQL via
 * Tier 3.4's `query_by_property` push-down filter. The previous
 * JS-side `b.block_type === 'page'` filter wasted bandwidth on
 * non-page rows that the backend now drops at query time.
 */
export async function loadTemplatePages(spaceId: string | null): Promise<BlockRow[]> {
  const resp = await queryByProperty({
    key: 'template',
    valueText: 'true',
    limit: paginationLimit(100),
    spaceId,
    blockType: 'page',
  })
  return resp.items
}

/**
 * Load the journal template page (property `journal-template` = 'true').
 * Returns the first matching page (or null) and an optional warning when
 * multiple journal templates are found so the caller can surface it to the user.
 *
 * `spaceId` (FEAT-3 Phase 4) — when set, restricts the search to the
 * active space.
 *
 * PEND-35 Tier 2.8 — `blockType: 'page'` is pushed into SQL so non-page
 * rows are dropped at query time rather than via a JS-side filter.
 */
export async function loadJournalTemplate(spaceId: string | null): Promise<{
  template: BlockRow | null
  duplicateWarning: string | null
}> {
  const resp = await queryByProperty({
    key: 'journal-template',
    valueText: 'true',
    limit: paginationLimit(10),
    spaceId,
    blockType: 'page',
  })
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
 * `spaceId` (FEAT-3 Phase 4) — when set, restricts templates to the
 * active space.
 *
 * PEND-35 Tier 2.8 — collapses the previous N+1
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
    firstChildren = await firstChildForBlocks(pages.map((p) => p.id))
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
 * Map the user-facing date-format tokens (`YYYY`/`DD`) onto the `date-fns`
 * pattern tokens (`yyyy`/`dd`). `date-fns` already uses `MM` for the
 * zero-padded month, so only year/day need translating. Mirrors the #1442
 * `{{date:FORMAT}}` mapping (`template-variables.ts#toDateFnsPattern`) — kept
 * as a local copy because that helper is module-private there and the `{{ }}`
 * system is intentionally NOT unified with the legacy `<% %>` one.
 */
function legacyToDateFnsPattern(userFormat: string): string {
  return userFormat.replace(/YYYY/g, 'yyyy').replace(/DD/g, 'dd')
}

/**
 * Format `date` with a user-supplied format string, falling back to
 * `fallback` (verbatim, never throwing) when the format is empty or invalid.
 */
function formatWithFallback(date: Date, userFormat: string | null, fallback: string): string {
  if (userFormat == null || userFormat.length === 0) return fallback
  try {
    const out = formatDateFns(date, legacyToDateFnsPattern(userFormat))
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
  weekday: (arg, now) => formatWithFallback(now, arg, formatDateFns(now, 'EEEE')),
  month: (arg, now) => formatWithFallback(now, arg, formatDateFns(now, 'MMMM')),
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
 * `FORMAT` uses `date-fns` tokens with the `{{date:FORMAT}}` `YYYY`/`DD`
 * convenience mapping (see `legacyToDateFnsPattern`). An invalid format falls
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

/**
 * Insert a template's children as new blocks under the given parent.
 * Recursively copies content, ordering, and nested structure from the
 * template page's entire subtree.
 *
 * Template variables are expanded during insertion: the legacy
 * `<% today %>` family AND the #1442 `{{date}}`/`{{date:FORMAT}}`/`{{time}}`/
 * `{{title}}` grammar (see `src/editor/template-variables.ts`). A
 * `{{cursor}}` marker in a block records the caret target: it is stripped
 * from the content and, when `context.onCursorBlock` is supplied, the
 * created block's id is reported back so the caller can focus it after the
 * template lands. Returns the IDs of all created blocks.
 *
 * PEND-35 Tier 4.3 — replaces the per-descendant `createBlock` IPC loop
 * with a single `createBlocksBatch` call. limit-clamp-followup — the
 * walk-children traversal also collapsed from one `listBlocks` IPC per
 * source parent (silently clamped to 100 children per level) into a
 * single `loadPageSubtree` IPC that returns the entire template subtree
 * in one SELECT against the materializer-maintained `page_id` index.
 * The specs are accumulated in DFS order with the source-id → batch-
 * index mapping tracked so each child's `parentId` resolves to the
 * freshly-created destination block from the same batch. Atomicity
 * changes: a single malformed spec now rolls the whole template back
 * instead of partially landing the prefix. The previous per-block
 * try/catch fall-through is gone — partial templates were never the
 * desired UX; the user expects "the template inserted" or a clean
 * failure.
 */
// oxlint-disable-next-line eslint/complexity -- pre-existing
export async function insertTemplateBlocks(
  templatePageId: string,
  parentId: string,
  spaceId: string | null,
  context?: { pageTitle?: string; onCursorBlock?: (blockId: string) => void },
): Promise<string[]> {
  // Templates belong to a single space, so the descendant fetch is
  // scoped to `spaceId`. The `?? ''` fallback exists for the pre-
  // bootstrap call paths inherited from the previous `listBlocks`
  // implementation; `loadPageSubtree`'s backend rejects an empty
  // spaceId with `AppError::Validation` (the root cannot carry
  // `space = ''`), so a real null-spaceId call propagates a loud
  // error instead of silently returning `[]`.  In practice
  // `insertTemplateBlocks` is only reached via user action after
  // bootstrap, so the fallback should never trigger.
  const effectiveSpaceId = spaceId ?? ''

  // Collect specs in DFS order. Each spec's `parentId` is either the
  // top-level destination (`parentId` arg) when the source's parent is
  // the template root, or a placeholder string of the form
  // `__BATCH_INDEX__<i>` that we resolve to the freshly-created block
  // id after the batch returns. We build a map source-id → batch-index
  // as we walk so children can reference their just-pushed parent.
  type DeferredSpec = { spec: CreateBlockSpec; resolveParentFromIndex: number | null }
  const deferred: DeferredSpec[] = []

  // Deferred index of the block that carried the `{{cursor}}` marker (the
  // first one wins). Resolved to a created block id after the batch lands and
  // reported via `context.onCursorBlock`.
  let cursorDeferredIndex: number | null = null

  // Single IPC fetches every descendant of the template root (root
  // itself excluded). Group by `parent_id` and sort each sibling group
  // by `position` so the DFS below reproduces the exact ordering the
  // old per-parent `listBlocks` walk produced.
  // #1258 — `loadPageSubtree` now returns `{ blocks, truncated, total }`.
  // Templates are authored, small subtrees, so truncation is not expected
  // here; take the blocks array. (A pathological >10k-block template would
  // be capped by the backend, matching the prior bare-array behaviour.)
  const descendants = (await loadPageSubtree(templatePageId, effectiveSpaceId)).blocks
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

  function walkChildren(sourceParentId: string, destParentIndex: number | null): void {
    const children = childrenByParent.get(sourceParentId)
    if (!children) return
    for (const child of children) {
      // Two-stage expansion: legacy `<% %>` first, then the #1442 `{{ }}`
      // grammar (which also strips any `{{cursor}}` marker and reports it).
      const legacyExpanded = expandTemplateVariables(child.content ?? '', context ?? {})
      const { text: expandedContent, hasCursor } = substituteTemplateVariables(
        legacyExpanded,
        context?.pageTitle === undefined ? {} : { pageTitle: context.pageTitle },
      )
      const myIndex = deferred.length
      if (hasCursor && cursorDeferredIndex === null) cursorDeferredIndex = myIndex
      deferred.push({
        spec: {
          blockType: 'content',
          content: expandedContent,
          // Real parentId resolved post-batch. For now use the
          // top-level dest; a child rewrites it via
          // `resolveParentFromIndex`.
          parentId: destParentIndex == null ? parentId : null,
          position: null,
          properties: {},
        },
        resolveParentFromIndex: destParentIndex,
      })
      // Recurse: grandchildren of `child` will reference `myIndex`.
      walkChildren(child.id, myIndex)
    }
  }

  walkChildren(templatePageId, null)

  if (deferred.length === 0) return []

  // First pass writes specs that point to top-level `parentId`. After
  // the batch lands we do NOT need a second pass — but the backend
  // accepts forward references via the same-tx parent probe, so the
  // simpler approach is to fix up every nested spec's parentId BEFORE
  // sending the batch, using the placeholder "this row is the parent"
  // index. Since we don't know the ULIDs yet, we leave `parentId =
  // null` for nested rows and patch each entry's `parentId` to the
  // top-level `parentId` when it has no source-parent, OR to a
  // sentinel that the batch can't yet resolve. Backend solution: we
  // call the batch in TWO halves... NO — simpler: we send N separate
  // batches, one per depth level. Children at depth d only reference
  // parents at depth d-1, which are already created.
  //
  // For simplicity and correctness with the all-or-nothing semantic,
  // we compute the depth groups and issue ONE IPC PER DEPTH LEVEL.
  // Most templates are 1-2 levels deep, so this is still 1-2 IPCs vs
  // the previous N (one per descendant). For deeper templates the
  // count scales with depth, not with descendant count.
  //
  // Group entries by depth. Depth 0 = direct children of `templatePageId`
  // (their `resolveParentFromIndex` is `null`).
  const depthByIndex: number[] = Array.from({ length: deferred.length }, () => 0)
  for (let i = 0; i < deferred.length; i += 1) {
    const parent = deferred[i]?.resolveParentFromIndex
    if (parent != null) {
      depthByIndex[i] = (depthByIndex[parent] ?? 0) + 1
    }
  }
  let maxDepth = 0
  for (const d of depthByIndex) if (d > maxDepth) maxDepth = d

  const ids: string[] = Array.from<string>({ length: deferred.length })
  // batch-index → created id (filled level-by-level)
  for (let level = 0; level <= maxDepth; level += 1) {
    const indicesAtLevel: number[] = []
    const specsAtLevel: CreateBlockSpec[] = []
    for (let i = 0; i < deferred.length; i += 1) {
      if ((depthByIndex[i] ?? 0) !== level) continue
      const entry = deferred[i]
      if (entry == null) continue
      const resolvedParentId =
        entry.resolveParentFromIndex == null
          ? parentId
          : (ids[entry.resolveParentFromIndex] ?? parentId)
      indicesAtLevel.push(i)
      specsAtLevel.push({ ...entry.spec, parentId: resolvedParentId })
    }
    if (specsAtLevel.length === 0) continue
    try {
      const created = await createBlocksBatch(specsAtLevel)
      for (let k = 0; k < indicesAtLevel.length; k += 1) {
        const idx = indicesAtLevel[k]
        if (idx == null) continue
        const row = created[k]
        if (row != null) ids[idx] = row.id
      }
    } catch (err) {
      logger.warn(
        'template-utils',
        'template batch insert failed at depth level',
        { level, count: specsAtLevel.length },
        err,
      )
      // Partial-template policy: stop on first error; previously
      // landed levels survive (mirror of the old per-block
      // try/catch → ids accumulate as far as we got).
      break
    }
  }

  // Report the caret-target block (from a `{{cursor}}` marker) once its real
  // id is known. Best-effort: if the cursor block's level failed to land its
  // id stays a hole and we simply don't fire the callback.
  if (cursorDeferredIndex !== null && context?.onCursorBlock) {
    const cursorId = ids[cursorDeferredIndex]
    if (typeof cursorId === 'string') context.onCursorBlock(cursorId)
  }

  // Filter out any holes (in case a level batch failed mid-way and
  // some indices were never populated).
  return ids.filter((id): id is string => typeof id === 'string')
}

/**
 * Load the per-space journal template (text property `journal_template`
 * on the space block itself). Returns the markdown string or null if
 * the property is not set.
 *
 * Distinct from the legacy `journal-template` page property — this one
 * lives directly on the space block as its `value_text`. FEAT-3p5b
 * makes this take precedence over the legacy global template page when
 * a daily journal page is created inside the space.
 */
export async function loadJournalTemplateForSpace(spaceId: string): Promise<string | null> {
  // PEND-35 Tier 2.4c — single-key PK lookup against `block_properties`
  // instead of fetching the whole vocabulary just to read one row.
  const row = await getProperty(spaceId, 'journal_template')
  return row?.value_text ?? null
}

/**
 * Parse a markdown template string and create one content block per
 * non-empty line under `parentId`. Variables (`<% today %>`,
 * `<% time %>`, `<% datetime %>`, `<% page title %>`) are expanded on
 * each line. Returns the IDs of all created blocks.
 *
 * PEND-35 Tier 4.3 — replaces the per-line `createBlock` IPC loop
 * with one `createBlocksBatch` call. A 10-line journal template that
 * previously fired 10 IPCs now fires 1. Atomicity changes: a single
 * malformed line (e.g. oversize content) now rolls the whole template
 * back instead of partially landing the prefix. The previous per-line
 * try/catch fall-through is gone — for a journal template every line
 * is well-formed user-authored markdown, and partial inserts were a
 * symptom of the legacy per-IPC failure model rather than a desired
 * UX.
 */
export async function insertTemplateBlocksFromString(
  template: string,
  parentId: string,
  context?: { pageTitle?: string },
): Promise<string[]> {
  // Split, then drop leading/trailing whitespace-only lines but keep
  // interior blank lines absent (we filter those per-line below).
  const lines = template.split('\n')
  let start = 0
  let end = lines.length
  while (start < end && (lines[start] ?? '').trim() === '') start += 1
  while (end > start && (lines[end - 1] ?? '').trim() === '') end -= 1
  const specs: CreateBlockSpec[] = []
  for (let i = start; i < end; i += 1) {
    const line = lines[i] ?? ''
    if (line.trim() === '') continue
    const expanded = expandTemplateVariables(line, context ?? {})
    specs.push({
      blockType: 'content',
      content: expanded,
      parentId,
      position: null,
      properties: {},
    })
  }
  if (specs.length === 0) return []
  try {
    const created = await createBlocksBatch(specs)
    return created.map((b) => b.id)
  } catch (err) {
    logger.warn(
      'template-utils',
      'journal template batch insert failed',
      { lineCount: specs.length },
      err,
    )
    return []
  }
}
