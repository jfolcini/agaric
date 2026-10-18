/**
 * What keeps a page out of page mode (#5691). Page mode shows everything a
 * block holds (#5743): its text and structure, its task, priority and dates,
 * its properties and attachments (`page-tasks.ts`), its list marker
 * (`page-lists.ts`), and a query's results or an embed (`page-rendered.ts`).
 * A page longer than `PAGE_MODE_BLOCK_CAP` stays in block mode:
 * ProseMirror renders the whole document.
 *
 * Collapse is block mode's view of the tree, not something blocks hold: page
 * mode shows every block, and the collapse state is there again in block mode.
 */

import { unwrap } from '@/lib/app-error'
import { type AttachmentRow, commands, type PropertyRow } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import type { FlatBlock } from '@/lib/tree-utils'

/** The most blocks page mode opens; a longer page stays in block mode. */
export const PAGE_MODE_BLOCK_CAP = 500

export interface PageModeBlocker {
  kind: 'overCap'
  count: number
}

/** What page mode reads of a page before it shows it. */
export interface PageFit {
  blocker: PageModeBlocker | null
  /** Each block's properties, by id; none read when the page is kept out. */
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

/** What keeps a page of `count` blocks out of page mode. */
export function blockerIn(count: number): PageModeBlocker | null {
  return count > blockCap() ? { kind: 'overCap', count } : null
}

/**
 * What keeps the page out of page mode, and what page mode draws of its
 * blocks: one read of their properties and one of their attachments for the
 * whole page.
 */
export async function readPageFit(blocks: readonly FlatBlock[], count: number): Promise<PageFit> {
  const blocker = blockerIn(count)
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
  return t('pageMode.blocked.overCap', { cap: blockCap(), blocks: blocker.count })
}
