/**
 * The row page mode draws under a block's text (#5743): block mode's
 * `BlockMetadataRow`, and the property editor its chips open
 * (`BlockPropertyEditor`), paired as `SortableBlock` pairs them. The editor
 * writes through the property commands; once it closes, page mode reads the
 * block's properties again (`onEdited`).
 */

import type React from 'react'
import { useState } from 'react'

import {
  BlockMetadataRow,
  type BlockMetadataRowProps,
} from '@/components/editor/BlockInlineControls'
import { BlockPropertyEditor } from '@/components/editor/BlockPropertyEditor'
import { usePropertyDefForEdit } from '@/hooks/usePropertyDefForEdit'

export type PageBlockMetadataProps = Omit<
  BlockMetadataRowProps,
  'attachmentCount' | 'showAttachments' | 'onToggleAttachments' | 'onEditProp' | 'onEditKey'
> & {
  /** The chip editor closed: what it may have written is read again. */
  onEdited: (blockId: string) => void
}

const noAttachments = (): void => {}

export function PageBlockMetadata({
  onEdited,
  ...row
}: PageBlockMetadataProps): React.ReactElement {
  const [editingProp, setEditingProp] = useState<{ key: string; value: string } | null>(null)
  const [editingKey, setEditingKey] = useState<{ oldKey: string; value: string } | null>(null)
  const definition = usePropertyDefForEdit(editingProp)
  const closing =
    <T,>(set: (next: T | null) => void) =>
    (next: T | null): void => {
      set(next)
      if (next === null) onEdited(row.blockId)
    }
  return (
    <>
      <BlockMetadataRow
        {...row}
        attachmentCount={0}
        showAttachments={false}
        onToggleAttachments={noAttachments}
        onEditProp={setEditingProp}
        onEditKey={setEditingKey}
      />
      {/* Its anchor takes no room: the popups float below the row. */}
      <div className="h-0">
        <BlockPropertyEditor
          blockId={row.blockId}
          editingProp={editingProp}
          setEditingProp={closing(setEditingProp)}
          editingKey={editingKey}
          setEditingKey={closing(setEditingKey)}
          {...definition}
        />
      </div>
    </>
  )
}
