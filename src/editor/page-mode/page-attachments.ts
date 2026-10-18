/**
 * Page mode's attachments (#5743). A block's attachments are the attachment
 * commands', not the document's, as its properties are (`page-properties.ts`):
 * page mode reads them with the page (`readPageFit`) and again each time it
 * brings the page in, and each block's row draws them as block mode does
 * (`PageBlockMetadata`).
 */

import type { AttachmentRow } from '@/lib/bindings'

const NONE: AttachmentRow[] = []

/** The page's attachments, by block id. */
export class PageAttachments {
  private held = new Map<string, AttachmentRow[]>()
  private readonly listeners = new Set<() => void>()

  constructor(rows: Record<string, AttachmentRow[]>) {
    this.take(rows)
  }

  of(id: string): AttachmentRow[] {
    return this.held.get(id) ?? NONE
  }

  /** Hold what a read of the page found, and tell the listeners. */
  take(rows: Record<string, AttachmentRow[]>): void {
    this.held = new Map(Object.entries(rows).filter(([, list]) => list.length > 0))
    for (const listener of this.listeners) listener()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
