/**
 * ConflictKeepDialog — confirms applying a conflict block's content to its
 * original (the "Keep incoming" flow). Shows a preview of the current
 * (original) and incoming (conflict) content side-by-side. Sibling
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

interface ConflictKeepDialogProps {
  block: BlockRow | null
  originals: Map<string, BlockRow>
  onOpenChange: (open: boolean) => void
  onConfirm: (block: BlockRow) => void
}

export function ConflictKeepDialog({
  block,
  originals,
  onOpenChange,
  onConfirm,
}: ConflictKeepDialogProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <ConfirmDialog
      open={!!block}
      onOpenChange={onOpenChange}
      title={t('conflict.keepIncomingTitle')}
      description={
        <>
          {t('conflict.keepDescription')}
          {block && (
            <span className="mt-2 block space-y-1 text-xs">
              <span className="block">
                <span className="font-medium">{t('conflict.currentLabel')}</span>{' '}
                <span className="text-muted-foreground">
                  {truncatePreview(
                    block.parent_id
                      ? (originals.get(block.parent_id)?.content ??
                          t('conflict.originalNotAvailable'))
                      : '(no original)',
                  )}
                </span>
              </span>
              <span className="block">
                <span className="font-medium">{t('conflict.incomingLabel')}</span>{' '}
                <span className="text-muted-foreground">
                  {truncatePreview(block.content ?? t('conflict.emptyContent'))}
                </span>
              </span>
            </span>
          )}
        </>
      }
      cancelLabel={t('dialog.cancel')}
      actionLabel={t('conflict.keepConfirmAction')}
      onAction={() => {
        if (block) onConfirm(block)
      }}
      actionVariant="destructive"
      className="conflict-keep-confirm"
      contentTestId="conflict-keep-confirm"
      cancelTestId="conflict-keep-no"
      actionTestId="conflict-keep-yes"
    />
  )
}
