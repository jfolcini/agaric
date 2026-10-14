/**
 * BlockTreeDialogs — the four block-level dialog MOUNTS extracted from BlockTree
 * (#2930): visual query builder (#215), emoji picker (#286), block-history
 * sheet and property drawer. State + handlers live in `useBlockDialogs`; this is
 * a pure presentational child fed entirely by props.
 *
 * #5441 — each dialog is lazy and mounted only while open, so its chunk loads on
 * first use instead of riding every BlockTree onto the boot path.
 */
import type { Dispatch, SetStateAction } from 'react'
import type React from 'react'
import { lazy, Suspense } from 'react'

const QueryBuilderModal = lazy(() =>
  import('@/components/dialogs/QueryBuilderModal').then((m) => ({
    default: m.QueryBuilderModal,
  })),
)
const EmojiPickerDialog = lazy(() =>
  import('@/components/EmojiPicker/EmojiPickerDialog').then((m) => ({
    default: m.EmojiPickerDialog,
  })),
)
const BlockHistorySheet = lazy(() =>
  import('@/components/editor/BlockHistorySheet').then((m) => ({
    default: m.BlockHistorySheet,
  })),
)
const BlockPropertyDrawerSheet = lazy(() =>
  import('@/components/editor/BlockPropertyDrawerSheet').then((m) => ({
    default: m.BlockPropertyDrawerSheet,
  })),
)

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
      {queryBuilderOpen && (
        <Suspense fallback={null}>
          <QueryBuilderModal
            open={queryBuilderOpen}
            onOpenChange={setQueryBuilderOpen}
            onSave={handleQuerySave}
          />
        </Suspense>
      )}

      {/* Browse-grid emoji picker for the /emoji slash command (#286) */}
      {emojiPickerOpen && (
        <Suspense fallback={null}>
          <EmojiPickerDialog
            open={emojiPickerOpen}
            onOpenChange={setEmojiPickerOpen}
            onSelect={handleEmojiSelect}
          />
        </Suspense>
      )}

      {/* History side-sheet for per-block history */}
      {historyBlockId && (
        <Suspense fallback={null}>
          <BlockHistorySheet
            blockId={historyBlockId}
            open
            onOpenChange={(open) => {
              if (!open) setHistoryBlockId(null)
            }}
          />
        </Suspense>
      )}

      {/* Property drawer for per-block properties */}
      {propertyDrawerBlockId && (
        <Suspense fallback={null}>
          <BlockPropertyDrawerSheet
            blockId={propertyDrawerBlockId}
            open
            onOpenChange={(open) => {
              if (!open) setPropertyDrawerBlockId(null)
            }}
          />
        </Suspense>
      )}
    </>
  )
}
