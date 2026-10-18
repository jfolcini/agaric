/**
 * What keeps a page out of page mode (#5691). Page mode shows a block's text,
 * its structure, its task, priority and dates, its properties and attachments
 * (`page-tasks.ts`) and its list marker (`page-lists.ts`); what else block mode
 * draws around the text it does not draw yet, so a page holding any of it
 * stays in block mode rather than hide it: the `{{query …}}` and `{{embed …}}`
 * blocks block mode renders as results. A page longer than
 * `PAGE_MODE_BLOCK_CAP` stays too: ProseMirror renders the whole document.
 * Showing these in page mode is #5743.
 *
 * Collapse is block mode's view of the tree, not something blocks hold: page
 * mode shows every block, and the collapse state is there again in block mode.
 */

import { unwrap } from '@/lib/app-error'
import { type AttachmentRow, commands, type PropertyRow } from '@/lib/bindings'
import { parseEmbedToken } from '@/lib/embed-token'
import { t } from '@/lib/i18n'
import type { FlatBlock } from '@/lib/tree-utils'

/** The most blocks page mode opens; a longer page stays in block mode. */
export const PAGE_MODE_BLOCK_CAP = 500

export type PageModeBlocker = { kind: 'overCap'; count: number } | { kind: 'queries' | 'embeds' }

/** What page mode reads of a page before it shows it. */
export interface PageFit {
  blocker: PageModeBlocker | null
  /** Each block's properties, by id; none read when the rows already keep the page out. */
  properties: Record<string, PropertyRow[]>
  /** Each block's attachments, by id, read alike. */
  attachments: Record<string, AttachmentRow[]>
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
    const content = block.content ?? ''
    // `StaticBlock`'s own sniff for the blocks it renders as query results.
    if (content.startsWith('{{query ') && content.endsWith('}}')) return { kind: 'queries' }
    if (parseEmbedToken(content) !== null) return { kind: 'embeds' }
  }
  return null
}

/**
 * What keeps the page out of page mode, and what page mode draws of its
 * blocks: one read of their properties and one of their attachments for the
 * whole page.
 */
export async function readPageFit(blocks: readonly FlatBlock[], count: number): Promise<PageFit> {
  const blocker = blockerIn(blocks, count)
  if (blocker !== null || blocks.length === 0) return { blocker, properties: {}, attachments: {} }
  const ids = blocks.map((block) => block.id)
  const [properties, attachments] = await Promise.all([
    commands.getBatchProperties(ids).then(unwrap),
    commands.listAttachmentsBatch(ids).then(unwrap),
  ])
  return { blocker: null, properties, attachments }
}

/** Why page mode is not offered, in a sentence. */
export function blockerMessage(blocker: PageModeBlocker): string {
  return blocker.kind === 'overCap'
    ? t('pageMode.blocked.overCap', { cap: blockCap(), blocks: blocker.count })
    : t(`pageMode.blocked.${blocker.kind}`)
}
