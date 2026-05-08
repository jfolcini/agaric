import { logger } from './logger'
import type { BlockRow } from './tauri'
import { createBlock, firstChildForBlocks, getProperty, listBlocks, queryByProperty } from './tauri'

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
 */
export async function insertTemplateBlocks(
  templatePageId: string,
  parentId: string,
  spaceId: string | null,
  context?: { pageTitle?: string },
): Promise<string[]> {
  const ids: string[] = []

  // FEAT-3 Phase 4 — `listBlocks` requires `spaceId`. Templates belong
  // to a single space, so the recursive copy walks within `spaceId`. The
  // `?? ''` fallback is the pre-bootstrap no-match sentinel.
  const effectiveSpaceId = spaceId ?? ''

  async function copyChildren(sourceParentId: string, destParentId: string): Promise<void> {
    const resp = await listBlocks({
      parentId: sourceParentId,
      limit: 500,
      spaceId: effectiveSpaceId,
    })
    for (const child of resp.items) {
      try {
        const expandedContent = expandTemplateVariables(child.content ?? '', context ?? {})
        const newBlock = await createBlock({
          blockType: 'content',
          content: expandedContent,
          parentId: destParentId,
        })
        ids.push(newBlock.id)
        // Recursively copy grandchildren
        await copyChildren(child.id, newBlock.id)
      } catch (err) {
        // Log warning but continue with remaining siblings.
        // Partial template is better than no template.
        logger.warn(
          'template-utils',
          'template block copy failed; skipping',
          { sourceBlockId: child.id },
          err,
        )
      }
    }
  }

  await copyChildren(templatePageId, parentId)
  return ids
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
 * Per-line `try/catch` mirrors {@link insertTemplateBlocks}: a single
 * line failure is logged and skipped so the rest of the template still
 * lands.
 */
export async function insertTemplateBlocksFromString(
  template: string,
  parentId: string,
  context?: { pageTitle?: string },
): Promise<string[]> {
  const ids: string[] = []
  // Split, then drop leading/trailing whitespace-only lines but keep
  // interior blank lines absent (we filter those per-line below).
  const lines = template.split('\n')
  let start = 0
  let end = lines.length
  while (start < end && (lines[start] ?? '').trim() === '') start += 1
  while (end > start && (lines[end - 1] ?? '').trim() === '') end -= 1
  for (let i = start; i < end; i += 1) {
    const line = lines[i] ?? ''
    if (line.trim() === '') continue
    try {
      const expanded = expandTemplateVariables(line, context ?? {})
      const newBlock = await createBlock({
        blockType: 'content',
        content: expanded,
        parentId,
      })
      ids.push(newBlock.id)
    } catch (err) {
      // Best-effort: log and continue with the remaining lines.
      logger.warn(
        'template-utils',
        'journal template line insert failed; skipping',
        { line: i, content: line },
        err,
      )
    }
  }
  return ids
}
