import type { BlockRow } from './tauri'
import { createBlock, listBlocks, queryByProperty } from './tauri'

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
      ? `Multiple journal templates found (${pages.length}). Using "${pages[0].content ?? pages[0].id}". ` +
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
        const text = children.items[0].content ?? ''
        preview = text.length > 60 ? `${text.slice(0, 60)}…` : text
      }
    } catch {
      // Preview is best-effort — skip on failure
    }
    result.push({ id: page.id, content: page.content ?? '', preview })
  }
  return result
}

/**
 * Insert a template's children as new blocks under the given parent.
 * Recursively copies content, ordering, and nested structure from the
 * template page's entire subtree.
 * Returns the IDs of all created blocks.
 */
export async function insertTemplateBlocks(
  templatePageId: string,
  parentId: string,
): Promise<string[]> {
  const ids: string[] = []

  async function copyChildren(sourceParentId: string, destParentId: string): Promise<void> {
    const resp = await listBlocks({ parentId: sourceParentId, limit: 500 })
    for (const child of resp.items) {
      try {
        const newBlock = await createBlock({
          blockType: 'content',
          content: child.content ?? '',
          parentId: destParentId,
        })
        ids.push(newBlock.id)
        // Recursively copy grandchildren
        await copyChildren(child.id, newBlock.id)
      } catch {
        // Log warning but continue with remaining siblings.
        // Partial template is better than no template.
        console.warn(`Template block copy failed for source ${child.id}, skipping`)
      }
    }
  }

  await copyChildren(templatePageId, parentId)
  return ids
}
