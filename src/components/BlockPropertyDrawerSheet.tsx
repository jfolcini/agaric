/**
 * BlockPropertyDrawerSheet -- block-level property drawer side-sheet.
 *
 * Thin extraction wrapper that keeps the BlockPropertyDrawer rendering
 * out of BlockTree's JSX.  Props follow the same open/close contract
 * used by all Sheet-based drawers in the app.
 */

import type React from 'react'
import { BlockPropertyDrawer } from '@/components/BlockPropertyDrawer'

export interface BlockPropertyDrawerSheetProps {
  /** The block whose properties to display, or null when idle. */
  blockId: string | null
  /** Whether the sheet is open. */
  open: boolean
  /** Called when the sheet requests to open or close. */
  onOpenChange: (open: boolean) => void
}

export function BlockPropertyDrawerSheet({
  blockId,
  open,
  onOpenChange,
}: BlockPropertyDrawerSheetProps): React.ReactElement {
  return <BlockPropertyDrawer blockId={blockId} open={open} onOpenChange={onOpenChange} />
}
