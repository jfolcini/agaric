/**
 * What keeps a page out of page mode (#5691). Page mode shows a block's text,
 * its structure and its task (`page-tasks.ts`); what else block mode draws
 * around the text it does not draw yet, so a page holding any of it stays in
 * block mode rather than hide it: priorities, dates, properties and
 * attachments, and the `{{query …}}` and `{{embed …}}` blocks block mode
 * renders as results. A page longer than `PAGE_MODE_BLOCK_CAP` stays too:
 * ProseMirror renders the whole document.
 * Showing these in page mode is #5743.
 *
 * Collapse is block mode's view of the tree, not something blocks hold: page
 * mode shows every block, and the collapse state is there again in block mode.
 */

import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { parseEmbedToken } from '@/lib/embed-token'
import { t } from '@/lib/i18n'
import { SYSTEM_MANAGED_PROPERTY_KEYS } from '@/lib/property-save-utils'
import type { FlatBlock } from '@/lib/tree-utils'

/** The most blocks page mode opens; a longer page stays in block mode. */
export const PAGE_MODE_BLOCK_CAP = 500

export type PageModeBlocker =
  | { kind: 'overCap'; count: number }
  | {
      kind: 'priorities' | 'dates' | 'properties' | 'attachments' | 'queries' | 'embeds'
    }

/** The cap, which only the perf harness's e2e build may raise (`e2e/perf.spec.ts`, `-g 'page mode'`). */
function blockCap(): number {
  if (import.meta.env.VITE_E2E) {
    const raised = (window as { __pageModeBlockCap?: unknown }).__pageModeBlockCap
    if (typeof raised === 'number') return raised
  }
  return PAGE_MODE_BLOCK_CAP
}

/** What of `blocks`, `count` blocks in all, keeps the page out of page mode: read from the rows alone. */
export function blockerIn(blocks: readonly FlatBlock[], count: number): PageModeBlocker | null {
  if (count > blockCap()) return { kind: 'overCap', count }
  for (const block of blocks) {
    if (block.priority !== null) return { kind: 'priorities' }
    if (block.due_date !== null || block.scheduled_date !== null) return { kind: 'dates' }
    const content = block.content ?? ''
    // `StaticBlock`'s own sniff for the blocks it renders as query results.
    if (content.startsWith('{{query ') && content.endsWith('}}')) return { kind: 'queries' }
    if (parseEmbedToken(content) !== null) return { kind: 'embeds' }
  }
  return null
}

/**
 * What keeps the page out of page mode, its blocks' properties and
 * attachments included: one read of each for the whole page. The stamps a
 * task's state writes (`created_at`, `completed_at`) are not the user's and
 * block mode's property row hides them (`INTERNAL_PROPERTY_KEYS`; only its
 * drawer lists them, read-only), so they keep nothing out.
 */
export async function pageModeBlocker(
  blocks: readonly FlatBlock[],
  count: number,
): Promise<PageModeBlocker | null> {
  const found = blockerIn(blocks, count)
  if (found !== null || blocks.length === 0) return found
  const ids = blocks.map((block) => block.id)
  const [properties, attachments] = await Promise.all([
    commands.getBatchProperties(ids).then(unwrap),
    commands.listAttachmentsBatch(ids).then(unwrap),
  ])
  const drawn = (rows: readonly { key: string }[]) =>
    rows.some((row) => !SYSTEM_MANAGED_PROPERTY_KEYS.has(row.key))
  if (Object.values(properties).some(drawn)) return { kind: 'properties' }
  if (Object.values(attachments).some((rows) => rows.length > 0)) return { kind: 'attachments' }
  return null
}

/** Why page mode is not offered, in a sentence. */
export function blockerMessage(blocker: PageModeBlocker): string {
  return blocker.kind === 'overCap'
    ? t('pageMode.blocked.overCap', { cap: blockCap(), blocks: blocker.count })
    : t(`pageMode.blocked.${blocker.kind}`)
}
