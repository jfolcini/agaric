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
 * Returns the first matching page, or null if none exists.
 * Warns to console if multiple journal templates are found.
 */
export async function loadJournalTemplate(): Promise<BlockRow | null> {
  const resp = await queryByProperty({ key: 'journal-template', valueText: 'true', limit: 10 })
  const pages = resp.items.filter((b) => b.block_type === 'page')
  if (pages.length > 1) {
    console.warn(
      `Multiple journal templates found (${pages.length}). Using "${pages[0].content ?? pages[0].id}". ` +
        'Remove the journal-template property from extra pages to avoid ambiguity.',
    )
  }
  return pages[0] ?? null
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
