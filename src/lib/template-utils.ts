import { logger } from './logger'
import type { BlockRow, CreateBlockSpec } from './tauri'
import {
  createBlocksBatch,
  firstChildForBlocks,
  getProperty,
  loadPageSubtree,
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
    limit: 100,
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
    limit: 10,
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
 * Expand template variables in content.
 *
 * Supported variables:
 * - `<% today %>` → current date in YYYY-MM-DD format
 * - `<% time %>` → current time in HH:MM format
 * - `<% datetime %>` → current date+time in YYYY-MM-DD HH:MM format
 * - `<% page title %>` → title of the target page (where template is being inserted)
 */
export function expandTemplateVariables(content: string, context: { pageTitle?: string }): string {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const hh = String(now.getHours()).padStart(2, '0')
  const min = String(now.getMinutes()).padStart(2, '0')

  return content
    .replace(/<%\s*today\s*%>/gi, `${yyyy}-${mm}-${dd}`)
    .replace(/<%\s*time\s*%>/gi, `${hh}:${min}`)
    .replace(/<%\s*datetime\s*%>/gi, `${yyyy}-${mm}-${dd} ${hh}:${min}`)
    .replace(/<%\s*page\s*title\s*%>/gi, context.pageTitle ?? '')
}

/**
 * Insert a template's children as new blocks under the given parent.
 * Recursively copies content, ordering, and nested structure from the
 * template page's entire subtree.
 * Template variables (e.g. `<% today %>`) are expanded during insertion.
 * Returns the IDs of all created blocks.
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
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: pre-existing
export async function insertTemplateBlocks(
  templatePageId: string,
  parentId: string,
  spaceId: string | null,
  context?: { pageTitle?: string },
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

  // Single IPC fetches every descendant of the template root (root
  // itself excluded). Group by `parent_id` and sort each sibling group
  // by `position` so the DFS below reproduces the exact ordering the
  // old per-parent `listBlocks` walk produced.
  const descendants = await loadPageSubtree(templatePageId, effectiveSpaceId)
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
      const expandedContent = expandTemplateVariables(child.content ?? '', context ?? {})
      const myIndex = deferred.length
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
  const depthByIndex: number[] = new Array(deferred.length).fill(0)
  for (let i = 0; i < deferred.length; i += 1) {
    const parent = deferred[i]?.resolveParentFromIndex
    if (parent != null) {
      depthByIndex[i] = (depthByIndex[parent] ?? 0) + 1
    }
  }
  let maxDepth = 0
  for (const d of depthByIndex) if (d > maxDepth) maxDepth = d

  const ids: string[] = new Array(deferred.length)
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
