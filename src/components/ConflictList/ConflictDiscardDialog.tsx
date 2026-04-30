/**
 * ConflictDiscardDialog — confirms deleting a conflict block (the
 * "Discard" flow). Shows a preview of the conflict's content. Sibling
 * extracted from ConflictList.tsx for MAINT-128.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import type { BlockRow } from '@/lib/tauri'

/** Truncate long content for dialog previews. */
function truncatePreview(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

interface ConflictDiscardDialogProps {
  blockId: string | null
  blocks: BlockRow[]
  onOpenChange: (open: boolean) => void
  onConfirm: (block: BlockRow) => void
}

export function ConflictDiscardDialog({
  blockId,
  blocks,
  onOpenChange,
  onConfirm,
}: ConflictDiscardDialogProps): React.ReactElement {
  const { t } = useTranslation()
  const discardBlock = blockId ? blocks.find((b) => b.id === blockId) : undefined
  return (
    <ConfirmDialog
      open={!!blockId}
      onOpenChange={onOpenChange}
      title={t('conflict.discardTitle')}
      description={
        <>
          {t('conflict.discardDescription')}
          {discardBlock ? (
            <span className="mt-2 block text-xs">
              <span className="font-medium">Content:</span>{' '}
              <span className="text-muted-foreground">
                {truncatePreview(discardBlock.content ?? t('conflict.emptyContent'))}
              </span>
            </span>
          ) : null}
        </>
      }
      cancelLabel={t('dialog.no')}
      actionLabel={t('conflict.discardConfirmAction')}
      onAction={() => {
        if (discardBlock) onConfirm(discardBlock)
      }}
      actionVariant="destructive"
      className="conflict-discard-confirm"
      contentTestId="conflict-discard-confirm"
      cancelTestId="conflict-discard-no"
      actionTestId="conflict-discard-yes"
    />
  )
}
