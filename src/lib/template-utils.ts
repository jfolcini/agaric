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
 * Insert a template's children as new blocks under the given parent.
 * Copies content and ordering from the template page's direct children.
 * Returns the IDs of the created blocks.
 */
export async function insertTemplateBlocks(
  templatePageId: string,
  parentId: string,
): Promise<string[]> {
  const resp = await listBlocks({ parentId: templatePageId, limit: 500 })
  const children = resp.items
  const ids: string[] = []
  for (const child of children) {
    const block = await createBlock({
      blockType: 'content',
      content: child.content ?? '',
      parentId,
    })
    ids.push(block.id)
  }
  return ids
}
