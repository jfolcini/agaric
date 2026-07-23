/**
 * BlockTreeDialogs — the four block-level dialog MOUNTS extracted from BlockTree
 * (#2930): visual query builder (#215), emoji picker (#286), block-history
 * sheet and property drawer. State + handlers live in `useBlockDialogs`; this is
 * a pure presentational child fed entirely by props — a verbatim JSX move with
 * zero behavior change.
 */
import type { Dispatch, SetStateAction } from 'react'
import type React from 'react'

import { QueryBuilderModal } from '@/components/dialogs/QueryBuilderModal'
import { BlockHistorySheet } from '@/components/editor/BlockHistorySheet'
import { BlockPropertyDrawerSheet } from '@/components/editor/BlockPropertyDrawerSheet'
import { EmojiPickerDialog } from '@/components/EmojiPicker'

interface BlockTreeDialogsProps {
  queryBuilderOpen: boolean
  setQueryBuilderOpen: Dispatch<SetStateAction<boolean>>
  handleQuerySave: (expression: string) => Promise<void>
  emojiPickerOpen: boolean
  setEmojiPickerOpen: Dispatch<SetStateAction<boolean>>
  handleEmojiSelect: (char: string) => void
  historyBlockId: string | null
  setHistoryBlockId: Dispatch<SetStateAction<string | null>>
  propertyDrawerBlockId: string | null
  setPropertyDrawerBlockId: Dispatch<SetStateAction<string | null>>
}

export function BlockTreeDialogs({
  queryBuilderOpen,
  setQueryBuilderOpen,
  handleQuerySave,
  emojiPickerOpen,
  setEmojiPickerOpen,
  handleEmojiSelect,
  historyBlockId,
  setHistoryBlockId,
  propertyDrawerBlockId,
  setPropertyDrawerBlockId,
}: BlockTreeDialogsProps): React.ReactElement {
  return (
    <>
      {/* Visual query builder for the /query slash command (#215) */}
      <QueryBuilderModal
        open={queryBuilderOpen}
        onOpenChange={setQueryBuilderOpen}
        onSave={handleQuerySave}
      />

      {/* Browse-grid emoji picker for the /emoji slash command (#286) */}
      <EmojiPickerDialog
        open={emojiPickerOpen}
        onOpenChange={setEmojiPickerOpen}
        onSelect={handleEmojiSelect}
      />

      {/* History side-sheet for per-block history */}
      <BlockHistorySheet
        blockId={historyBlockId}
        open={!!historyBlockId}
        onOpenChange={(open) => {
          if (!open) setHistoryBlockId(null)
        }}
      />

      {/* Property drawer for per-block properties */}
      <BlockPropertyDrawerSheet
        blockId={propertyDrawerBlockId}
        open={!!propertyDrawerBlockId}
        onOpenChange={(open) => {
          if (!open) setPropertyDrawerBlockId(null)
        }}
      />
    </>
  )
}
