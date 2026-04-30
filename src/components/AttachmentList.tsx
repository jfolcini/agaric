/**
 * AttachmentList -- displays attachments for a block.
 *
 * Renders each attachment with a MIME-type icon, filename, human-readable size,
 * relative timestamp, and a delete button with confirmation toast.
 * Compact layout with touch-friendly sizing.
 */

import { Paperclip, Trash2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { cn } from '@/lib/utils'
import { useBlockAttachments } from '../hooks/useBlockAttachments'
import { formatSize } from '../lib/attachment-utils'
import { formatRelativeTime } from '../lib/format-relative-time'
import type { AttachmentRow } from '../lib/tauri'
import { EmptyState } from './EmptyState'
import { ListViewState } from './ListViewState'
import { MimeIcon } from './MimeIcon'

// Re-exported for back-compat with tests / consumers that imported it from here.
export { formatSize }

interface AttachmentListProps {
  blockId: string
}

export function AttachmentList({ blockId }: AttachmentListProps): React.ReactElement {
  const { t } = useTranslation()
  const { attachments, loading, handleDeleteAttachment } = useBlockAttachments(blockId)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  // Tracks the pendingDeleteId reset setTimeout so we can cancel it on unmount
  // and avoid calling setState on an unmounted component (#MAINT-48).
  const pendingDeleteClearRef = useRef<number | null>(null)

  // Clear any pending reset timer on unmount.
  useEffect(
    () => () => {
      if (pendingDeleteClearRef.current !== null) {
        window.clearTimeout(pendingDeleteClearRef.current)
        pendingDeleteClearRef.current = null
      }
    },
    [],
  )

  const onDelete = useCallback(
    (attachment: AttachmentRow) => {
      if (pendingDeleteId === attachment.id) {
        // Second click — confirmed
        if (pendingDeleteClearRef.current !== null) {
          window.clearTimeout(pendingDeleteClearRef.current)
          pendingDeleteClearRef.current = null
        }
        handleDeleteAttachment(attachment.id)
        setPendingDeleteId(null)
        toast.success(t('attachments.deleted', { name: attachment.filename }))
      } else {
        // First click — show confirmation via toast
        setPendingDeleteId(attachment.id)
        toast(t('attachments.confirmDelete', { name: attachment.filename }), {
          description: t('attachments.clickAgain'),
          duration: 3000,
        })
        // Cancel any previous reset timer before scheduling a new one.
        if (pendingDeleteClearRef.current !== null) {
          window.clearTimeout(pendingDeleteClearRef.current)
        }
        // Auto-reset after toast disappears
        pendingDeleteClearRef.current = window.setTimeout(() => {
          pendingDeleteClearRef.current = null
          setPendingDeleteId((current) => (current === attachment.id ? null : current))
        }, 3000)
      }
    },
    [pendingDeleteId, handleDeleteAttachment, t],
  )

  return (
    <ListViewState
      loading={loading}
      items={attachments}
      skeleton={
        <LoadingSkeleton
          count={2}
          height="h-8"
          role="status"
          aria-label={t('attachments.loading')}
        />
      }
      empty={<EmptyState compact icon={Paperclip} message={t('attachments.empty')} />}
    >
      {(items) => (
        <ul className="space-y-1" aria-label={t('attachments.list')}>
          {items.map((attachment) => (
            <li
              key={attachment.id}
              className="group flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/50 active:bg-accent/70"
            >
              <MimeIcon mimeType={attachment.mime_type} />
              <span className="truncate flex-1 text-sm font-medium" title={attachment.filename}>
                {attachment.filename}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatSize(attachment.size_bytes)}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatRelativeTime(attachment.created_at, t)}
              </span>
              <button
                type="button"
                aria-label={t('attachments.delete', { name: attachment.filename })}
                className={cn(
                  'shrink-0 rounded-sm p-1 transition-opacity focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden active:scale-95 touch-target [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:flex [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center',
                  pendingDeleteId === attachment.id
                    ? 'text-destructive opacity-100 bg-destructive/10'
                    : 'text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100',
                )}
                onClick={() => onDelete(attachment)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </ListViewState>
  )
}
