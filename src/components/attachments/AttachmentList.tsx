/**
 * AttachmentList -- displays attachments for a block.
 *
 * Renders each attachment with a MIME-type icon, filename, human-readable size,
 * relative timestamp, and a delete button with confirmation notify.
 * Compact layout with touch-friendly sizing.
 */

import { Paperclip, Pencil, Trash2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { ListViewState } from '@/components/common/ListViewState'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { MimeIcon } from '@/components/rendering/MimeIcon'
import { useBlockAttachments } from '@/hooks/useBlockAttachments'
import { formatSize } from '@/lib/attachment-utils'
import { formatRelativeTime } from '@/lib/format-relative-time'
import { notify } from '@/lib/notify'
import type { AttachmentRow } from '@/lib/tauri'
import { cn } from '@/lib/utils'

// Re-exported for back-compat with tests / consumers that imported it from here.
export { formatSize }

/**
 * How long the "click again to confirm" toast stays visible AND how long the
 * pending-delete state lingers before resetting. The two MUST stay in sync —
 * if the toast disappears while pending state is still armed, a stray second
 * click would silently delete with no visual confirmation.
 */
const TOAST_DELETE_CONFIRM_TIMEOUT_MS = 3000

interface AttachmentListProps {
  blockId: string
}

export function AttachmentList({ blockId }: AttachmentListProps): React.ReactElement {
  const { t } = useTranslation()
  const { attachments, loading, handleDeleteAttachment, handleRenameAttachment } =
    useBlockAttachments(blockId)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
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
        notify.success(t('attachments.deleted', { name: attachment.filename }))
      } else {
        // First click — show confirmation via toast
        setPendingDeleteId(attachment.id)
        notify(t('attachments.confirmDelete', { name: attachment.filename }), {
          description: t('attachments.clickAgain'),
          duration: TOAST_DELETE_CONFIRM_TIMEOUT_MS,
        })
        // Cancel any previous reset timer before scheduling a new one.
        if (pendingDeleteClearRef.current !== null) {
          window.clearTimeout(pendingDeleteClearRef.current)
        }
        // Auto-reset after toast disappears
        pendingDeleteClearRef.current = window.setTimeout(() => {
          pendingDeleteClearRef.current = null
          setPendingDeleteId((current) => (current === attachment.id ? null : current))
        }, TOAST_DELETE_CONFIRM_TIMEOUT_MS)
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
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- role is a prop forwarded to the <LoadingSkeleton> component, not a DOM element; no native tag applies here
          role="status"
          aria-label={t('attachments.loading')}
        />
      }
      empty={<EmptyState compact icon={Paperclip} message={t('attachments.empty')} />}
    >
      {(items) => {
        const totalBytes = items.reduce((sum, a) => sum + a.size_bytes, 0)
        return (
          <div>
            <p className="mb-1 px-2 text-xs text-muted-foreground" aria-live="polite">
              {t('attachments.summary', { count: items.length, total: formatSize(totalBytes) })}
            </p>
            <ul className="space-y-1" aria-label={t('attachments.list')}>
              {items.map((attachment) => (
                <li
                  key={attachment.id}
                  className="group flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/50 active:bg-accent/70"
                >
                  <MimeIcon mimeType={attachment.mime_type} />
                  {editingId === attachment.id ? (
                    <input
                      // Focus + select on mount via callback ref instead of the
                      // `autoFocus` attribute (oxlint jsx-a11y/no-autofocus): the
                      // input only mounts when the user opts into rename, so
                      // focusing it is expected, and selecting lets them overtype.
                      // Guard on activeElement so re-renders while the user is
                      // typing don't re-select and clobber their input.
                      ref={(el) => {
                        if (el && document.activeElement !== el) {
                          el.focus()
                          el.select()
                        }
                      }}
                      aria-label={t('attachments.rename', { name: attachment.filename })}
                      className="flex-1 text-sm font-medium border rounded px-1 py-0.5 focus-ring-visible"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const trimmed = editValue.trim()
                          if (trimmed && trimmed !== attachment.filename) {
                            handleRenameAttachment(attachment.id, trimmed)
                          }
                          setEditingId(null)
                        } else if (e.key === 'Escape') {
                          setEditingId(null)
                        }
                      }}
                      onBlur={() => setEditingId(null)}
                    />
                  ) : (
                    <span
                      className="truncate flex-1 text-sm font-medium"
                      title={attachment.filename}
                    >
                      {attachment.filename}
                    </span>
                  )}
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatSize(attachment.size_bytes)}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatRelativeTime(attachment.created_at, t)}
                  </span>
                  <button
                    type="button"
                    aria-label={t('attachments.rename', { name: attachment.filename })}
                    className="shrink-0 rounded-sm p-1 text-muted-foreground hover:text-foreground transition-opacity opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-ring-visible active:scale-95 [@media(pointer:coarse)]:opacity-100"
                    onClick={() => {
                      setEditingId(attachment.id)
                      setEditValue(attachment.filename)
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={t('attachments.delete', { name: attachment.filename })}
                    className={cn(
                      'shrink-0 rounded-sm p-1 transition-opacity focus-visible:opacity-100 focus-ring-visible active:scale-95 touch-target [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:flex [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center',
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
          </div>
        )
      }}
    </ListViewState>
  )
}
