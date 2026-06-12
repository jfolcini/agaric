/**
 * PageQuickActions — unified star + delete affordance for page surfaces.
 *
 * Single source of truth for the inline page-action cluster shared by:
 *   - `PageHeader` (variant: 'header')  — page-editor chrome.
 *   - journal `DaySection` (variant: 'journal') — day-header chrome.
 *   - (future) Pages-list `DensityRow` (variant: 'row').
 *
 * Principle (PEND-68 Part A): star is a safe, reversible toggle → always
 * visible. Delete is destructive → wrapped in a ConfirmDialog upstream,
 * and the trigger button gets destructive-on-hover styling + disabled
 * during in-flight IPC. Recovery from a mistaken delete is handled by
 * the success toast's Undo action (owned by `usePageDeleteAction`).
 *
 * The component is *display only*. State comes from:
 *   - `useStarredPages()` for the star toggle.
 *   - `usePageDeleteAction()` (owned by the host) for the delete flow —
 *     this component just calls the `onDeleteRequest` callback the host
 *     wires to `requestDelete`. Centralising the dialog in the host is
 *     what avoids double-confirm dialogs when a host has multiple delete
 *     entry points (PageHeader has the dedicated trash button AND the
 *     kebab "Delete page" item; only one dialog ever renders).
 *
 * a11y:
 *   - Star: `aria-pressed`, state-driven `aria-label`, fills when starred.
 *   - Delete: state-driven `aria-label` (always "Delete page" for now).
 *   - 44 px touch targets on coarse pointers via the standard
 *     `[@media(pointer:coarse)]:h-11` pattern (reused from DensityRow).
 *   - Focus-visible rings inherited from `IconButton` → `Button`.
 *
 * Layout variants:
 *   - 'header' — `icon-sm`, always visible. The page header has plenty
 *     of room and the star is a primary affordance.
 *   - 'journal' — `icon-xs`, always visible. The star + delete in the
 *     journal day header were too easy to miss when gated behind
 *     group-hover, so a live UX review asked for them to render
 *     unconditionally (same as 'header', just the smaller `icon-xs` size).
 *   - 'row' — `icon-xs`, same hover-reveal as journal. Kept here so a
 *     future `DensityRow` refactor (PEND-68 A4, deferred) can switch
 *     without touching this file's surface area.
 */

import { Star, Trash2 } from 'lucide-react'
import type React from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { IconButton } from '@/components/ui/icon-button'
import { useStarredPages } from '@/hooks/useStarredPages'
import { cn } from '@/lib/utils'

export type PageQuickActionsVariant = 'header' | 'journal' | 'row'

export interface PageQuickActionsProps {
  pageId: string
  /** Page title — passed to the delete-request callback for confirm-dialog copy. */
  title: string
  /** Visual + layout preset. See file header. */
  variant: PageQuickActionsVariant
  /**
   * Hide the delete button — useful for surfaces where delete doesn't
   * belong (e.g. a future read-only context). Defaults to `true` (show).
   */
  showDelete?: boolean
  /**
   * Disables the delete button (parent is mid-delete). Defaults to
   * `false`. Hosts wire this to `usePageDeleteAction().isDeleting` or
   * `deletingId === pageId`.
   */
  deleting?: boolean
  /**
   * Called when the delete button is clicked. The host wires this to
   * `usePageDeleteAction().requestDelete(pageId, title)` (or its
   * journal-flavoured variant with custom confirm copy).
   */
  onDeleteRequest: (pageId: string, title: string) => void
  /** Optional className passed to the wrapper for one-off positioning. */
  className?: string
}

interface VariantPreset {
  size: 'icon-xs' | 'icon-sm' | 'icon'
  iconClass: string
  /** Whether the action cluster fades in on group-hover (desktop). */
  hoverReveal: boolean
}

const PRESETS: Record<PageQuickActionsVariant, VariantPreset> = {
  header: {
    size: 'icon-sm',
    iconClass: 'h-4 w-4',
    hoverReveal: false,
  },
  journal: {
    size: 'icon-xs',
    iconClass: 'h-3.5 w-3.5',
    // Always visible (not hover-only): the star + delete in the journal day
    // header were too easy to miss when gated behind group-hover. Live UX
    // review asked for them to render unconditionally.
    hoverReveal: false,
  },
  row: {
    size: 'icon-xs',
    iconClass: 'h-3.5 w-3.5',
    hoverReveal: true,
  },
}

/**
 * Shared class fragment that delivers:
 *   - hover-reveal opacity transition (desktop only),
 *   - always-visible on coarse pointers (touch),
 *   - focus-visible opacity bump (keyboard nav can still find the button),
 *   - 44 px hit target on coarse pointers via `[@media(pointer:coarse)]:h-11`.
 */
const HOVER_REVEAL =
  'shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity'
const TOUCH_TARGET = '[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11'

export function PageQuickActions({
  pageId,
  title,
  variant,
  showDelete = true,
  deleting = false,
  onDeleteRequest,
  className,
}: PageQuickActionsProps): React.ReactElement {
  const { t } = useTranslation()
  const { isStarred, toggle } = useStarredPages()
  const preset = PRESETS[variant]
  const starred = isStarred(pageId)

  const handleToggleStar = useCallback(() => {
    toggle(pageId)
  }, [pageId, toggle])

  const handleDelete = useCallback(() => {
    if (deleting) return
    onDeleteRequest(pageId, title)
  }, [deleting, onDeleteRequest, pageId, title])

  const starLabel = starred ? t('pageHeader.unstarPage') : t('pageHeader.starPage')
  const deleteLabel = t('pageHeader.deletePage')

  const revealClass = preset.hoverReveal ? HOVER_REVEAL : 'shrink-0'

  return (
    <div
      data-page-quick-actions
      data-variant={variant}
      className={cn('inline-flex items-center gap-1', className)}
    >
      <IconButton
        variant="ghost"
        size={preset.size}
        tooltip={starLabel}
        ariaLabel={starLabel}
        aria-pressed={starred}
        data-starred={starred}
        onClick={handleToggleStar}
        className={cn(
          revealClass,
          TOUCH_TARGET,
          'text-muted-foreground hover:text-star data-[starred=true]:text-star data-[starred=true]:opacity-100',
        )}
      >
        <Star className={preset.iconClass} fill={starred ? 'currentColor' : 'none'} />
      </IconButton>
      {showDelete && (
        <IconButton
          variant="ghost"
          size={preset.size}
          tooltip={deleteLabel}
          ariaLabel={deleteLabel}
          disabled={deleting}
          onClick={handleDelete}
          className={cn(
            revealClass,
            TOUCH_TARGET,
            'text-muted-foreground hover:text-destructive active:text-destructive active:scale-95',
          )}
        >
          <Trash2 className={preset.iconClass} />
        </IconButton>
      )}
    </div>
  )
}
