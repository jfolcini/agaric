/**
 * What page mode draws under a block's text (#5743), as block mode draws it:
 * the attachments' previews (`StaticBlockAttachments`), then `BlockMetadataRow`
 * with the attachment badge, whose list (`AttachmentList`) opens under it, and
 * the property editor its chips open (`BlockPropertyEditor`), paired as
 * `SortableBlock` pairs them. The editor and the list write through the
 * property and attachment commands; once the editor closes, or the list
 * changes an attachment, page mode reads the page again (`onEdited`,
 * `onAttachmentsChanged`).
 */

import type React from 'react'
import { useMemo, useState } from 'react'

import { AttachmentList } from '@/components/attachments/AttachmentList'
import {
  BlockMetadataRow,
  type BlockMetadataRowProps,
} from '@/components/editor/BlockInlineControls'
import { BlockPropertyEditor } from '@/components/editor/BlockPropertyEditor'
import { StaticBlockAttachments } from '@/components/editor/StaticBlockAttachments'
import { BatchAttachmentsContext } from '@/hooks/useBatchAttachments'
import { BatchPropertiesContext } from '@/hooks/useBatchPropertyRows'
import { usePropertyDefForEdit } from '@/hooks/usePropertyDefForEdit'
import type { AttachmentRow, PropertyRow } from '@/lib/bindings'

export type PageBlockMetadataProps = Omit<
  BlockMetadataRowProps,
  'attachmentCount' | 'showAttachments' | 'onToggleAttachments' | 'onEditProp' | 'onEditKey'
> & {
  attachments: AttachmentRow[]
  /** The chip editor closed: what it may have written is read again. */
  onEdited: () => void
  /** An attachment was deleted, renamed or replaced: the page's are read again. */
  onAttachmentsChanged: () => void
}

/** A property as the batch read returns it; the image keys the previews read are text. */
const asRow = ({ key, value }: { key: string; value: string }): PropertyRow => ({
  key,
  value_text: value,
  value_num: null,
  value_date: null,
  value_ref: null,
  value_bool: null,
})

export function PageBlockMetadata({
  attachments,
  onEdited,
  onAttachmentsChanged,
  ...row
}: PageBlockMetadataProps): React.ReactElement {
  const [editingProp, setEditingProp] = useState<{ key: string; value: string } | null>(null)
  const [editingKey, setEditingKey] = useState<{ oldKey: string; value: string } | null>(null)
  const [showAttachments, setShowAttachments] = useState(false)
  const definition = usePropertyDefForEdit(editingProp)
  const { blockId, properties } = row
  // Block mode's batch providers, answered from page mode's read: the list and
  // the previews read their rows here, not one IPC per block, and what they
  // change reads the page again.
  const batchAttachments = useMemo(
    () => ({
      get: (id: string) => (id === blockId ? attachments : undefined),
      getCount: (id: string) => (id === blockId ? attachments.length : 0),
      invalidate: onAttachmentsChanged,
    }),
    [blockId, attachments, onAttachmentsChanged],
  )
  const batchProperties = useMemo(() => {
    const rows = (properties ?? []).map(asRow)
    return {
      get: (id: string) => (id === blockId ? rows : undefined),
      invalidate: onEdited,
    }
  }, [blockId, properties, onEdited])
  const closing =
    <T,>(set: (next: T | null) => void) =>
    (next: T | null): void => {
      set(next)
      if (next === null) onEdited()
    }
  return (
    <BatchAttachmentsContext.Provider value={batchAttachments}>
      {attachments.length > 0 && (
        <BatchPropertiesContext.Provider value={batchProperties}>
          <StaticBlockAttachments blockId={blockId} attachments={attachments} />
        </BatchPropertiesContext.Provider>
      )}
      <BlockMetadataRow
        {...row}
        attachmentCount={attachments.length}
        showAttachments={showAttachments}
        onToggleAttachments={() => setShowAttachments((shown) => !shown)}
        onEditProp={setEditingProp}
        onEditKey={setEditingKey}
      />
      {showAttachments && attachments.length > 0 && (
        <div className="mt-1 ml-5 border-l-2 border-border/30 pl-3">
          <AttachmentList blockId={blockId} />
        </div>
      )}
      {/* Its anchor takes no room: the popups float below the row. */}
      <div className="h-0">
        <BlockPropertyEditor
          blockId={blockId}
          editingProp={editingProp}
          setEditingProp={closing(setEditingProp)}
          editingKey={editingKey}
          setEditingKey={closing(setEditingKey)}
          {...definition}
        />
      </div>
    </BatchAttachmentsContext.Provider>
  )
}
