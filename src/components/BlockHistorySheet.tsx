/**
 * BlockHistorySheet -- block-level history side-drawer.
 *
 * Thin extraction wrapper that keeps the HistorySheet rendering out of
 * BlockTree's JSX.  Props are the same open/close contract used by all
 * Sheet-based drawers in the app.
 */

import type React from 'react'
import { HistorySheet } from '@/components/HistorySheet'

export interface BlockHistorySheetProps {
  /** The block whose history to display, or null when idle. */
  blockId: string | null
  /** Whether the sheet is open. */
  open: boolean
  /** Called when the sheet requests to open or close. */
  onOpenChange: (open: boolean) => void
}

export function BlockHistorySheet({
  blockId,
  open,
  onOpenChange,
}: BlockHistorySheetProps): React.ReactElement {
  return <HistorySheet blockId={blockId} open={open} onOpenChange={onOpenChange} />
}
