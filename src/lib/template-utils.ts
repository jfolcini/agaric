import { logger } from './logger'
import type { BlockRow } from './tauri'
import { createBlock, getProperties, listBlocks, queryByProperty } from './tauri'

/**
 * Load all pages marked as templates (property `template` = 'true').
 */
export async function loadTemplatePages(): Promise<BlockRow[]> {
  const resp = await queryByProperty({ key: 'template', valueText: 'true', limit: 100 })
  return resp.items.filter((b) => b.block_type === 'page')
}

/**
 * Load the journal template page (property `journal-template` = 'true').
 * Returns the first matching page (or null) and an optional warning when
 * multiple journal templates are found so the caller can surface it to the user.
 */
export async function loadJournalTemplate(): Promise<{
  template: BlockRow | null
  duplicateWarning: string | null
}> {
  const resp = await queryByProperty({ key: 'journal-template', valueText: 'true', limit: 10 })
  const pages = resp.items.filter((b) => b.block_type === 'page')
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
 */
export async function loadTemplatePagesWithPreview(): Promise<
  Array<{ id: string; content: string; preview: string | null }>
> {
  const pages = await loadTemplatePages()
  const result: Array<{ id: string; content: string; preview: string | null }> = []
  for (const page of pages) {
    let preview: string | null = null
    try {
      const children = await listBlocks({ parentId: page.id, limit: 1 })
      if (children.items.length > 0) {
        const text = children.items[0]?.content ?? ''
        preview = text.length > 60 ? `${text.slice(0, 60)}…` : text
      }
    } catch (err) {
      // Preview is best-effort — skip on failure but log so we can
      // correlate with backend errors during support.
      logger.warn('template-utils', 'template preview fetch failed', { pageId: page.id }, err)
    }
    result.push({ id: page.id, content: page.content ?? '', preview })
  }
  return result
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
  context?: { pageTitle?: string },
): Promise<string[]> {
  const ids: string[] = []

  async function copyChildren(sourceParentId: string, destParentId: string): Promise<void> {
    const resp = await listBlocks({ parentId: sourceParentId, limit: 500 })
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
  const props = await getProperties(spaceId)
  const row = props.find((p) => p.key === 'journal_template')
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
