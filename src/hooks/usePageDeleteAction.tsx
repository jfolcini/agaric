/**
 * usePageDeleteAction — orchestrates the page-delete user flow (confirm
 * dialog → IPC → success toast with Undo → restore on click).
 *
 * Sits one layer above `deleteBlock`. PageHeader, journal DaySection,
 * and PageBrowser share the same UX:
 *
 *   1. Click delete → open a ConfirmDialog.
 *   2. On confirm → call `deleteBlock(pageId)` (soft-delete → Trash).
 *   3. On success → show a success toast with an "Undo" action that
 *      calls `restoreBlocksByIds([pageId])` (single-id restore).
 *   4. On failure → show an error toast with a Retry action.
 *
 * The hook owns:
 *   - The pending `deleteTarget` (`null` when no dialog open).
 *   - The in-flight `deletingId` (drives disabled state on buttons).
 *   - A `confirmDialog` React node — the host just embeds `{confirmDialog}`
 *     once in its JSX and forwards `requestDelete()` to any number of
 *     trigger buttons. Only ONE dialog instance ever renders, so there's
 *     no double-confirm risk when the same host has multiple delete
 *     entry points (e.g. PageHeader's dedicated trash button AND its
 *     kebab "Delete page" item).
 *
 * The hook does NOT mutate any list state. Callers that need post-delete
 * or post-restore side effects pass `onDeleted(pageId)` / `onRestored(pageId)`
 * callbacks. The optional `confirmCopy` lets each surface preserve its
 * established dialog copy.
 *
 * Undo is wired to the existing `restoreBlocksByIds` IPC, which accepts
 * a list and cascade-restores the root + descendants in a single
 * Transaction. For a single page that's effectively a
 * one-element call.
 */

import type React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { invalidateCalendarPageDates } from '@/hooks/useCalendarPageDates'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { invalidateNameCaches, notifyPagesRemoved } from '@/lib/name-change-bus'
import { notify } from '@/lib/notify'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

/** Locked-in copy slots a caller can override per-invocation. */
export interface PageDeleteConfirmCopy {
  /** Dialog title i18n key. Default: `pageHeader.deletePageTitle`. */
  titleKey?: string
  /** Dialog body i18n key. Default: `pageHeader.deleteConfirm`. */
  descriptionKey?: string
  /** Confirm-button i18n key. Default: `pageHeader.deletePage`. */
  confirmKey?: string
  /** Cancel-button i18n key. Default: `pageHeader.cancel`. */
  cancelKey?: string
  /** Values for interpolating the title/description keys via `t()`. */
  values?: Record<string, string | number>
}

export interface RequestDeleteOptions {
  /** Override the default confirm-dialog copy (used by the journal). */
  confirmCopy?: PageDeleteConfirmCopy
  /**
   * Called once the delete IPC resolves successfully. Used by hosts that
   * need post-delete UI side effects (PageHeader → `onBack()` + AT
   * `announce(...)`).
   */
  onDeleted?: (pageId: string) => void
  /** Called once an Undo restore resolves successfully. */
  onRestored?: (pageId: string) => void
  /**
   * Called when the delete IPC rejects. Lets the host surface an AT
   * announcement or any other failure-only side effect; the shared
   * error toast (with Retry) still fires unconditionally.
   */
  onFailed?: (pageId: string, error: unknown) => void
}

/** Stable empty-values default so the confirm dialog memo doesn't rebuild each render. */
const EMPTY_VALUES: Record<string, string | number> = {}

interface DeleteTarget {
  id: string
  title: string
  originSpaceId: string | null
  copy: PageDeleteConfirmCopy
  onDeleted: ((pageId: string) => void) | undefined
  onRestored: ((pageId: string) => void) | undefined
  onFailed: ((pageId: string, error: unknown) => void) | undefined
}

/**
 * Keep resolve-cache writes in the space where the action originated. A user
 * may switch spaces while either IPC is pending; writing through the store
 * after that switch would otherwise insert the old page under the new space.
 */
function setResolveDeletedStatus(target: DeleteTarget, deleted: boolean): void {
  if (useSpaceStore.getState().currentSpaceId !== target.originSpaceId) return
  useResolveStore.getState().set(target.id, target.title, deleted)
}

export interface UsePageDeleteActionReturn {
  /** Open the confirm dialog for the given page. */
  requestDelete: (pageId: string, title: string, options?: RequestDeleteOptions) => void
  /** `true` while the IPC is in flight. */
  isDeleting: boolean
  /** The id currently being deleted (or `null`). */
  deletingId: string | null
  /** Embed once in the host's JSX — owns the single ConfirmDialog instance. */
  confirmDialog: React.ReactElement
}

export function usePageDeleteAction(): UsePageDeleteActionReturn {
  const { t } = useTranslation()
  const [target, setTarget] = useState<DeleteTarget | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const requestDelete = useCallback(
    (pageId: string, title: string, options?: RequestDeleteOptions) => {
      const resolveStore = useResolveStore.getState()
      setTarget({
        id: pageId,
        // Preserve the authoritative cached title when one exists. The visible
        // row/header title remains the fallback for pages not preloaded yet.
        title: resolveStore.has(pageId) ? resolveStore.resolveTitle(pageId) : title,
        originSpaceId: useSpaceStore.getState().currentSpaceId,
        copy: options?.confirmCopy ?? {},
        onDeleted: options?.onDeleted,
        onRestored: options?.onRestored,
        onFailed: options?.onFailed,
      })
    },
    [],
  )

  const handleUndo = useCallback(
    (deletedTarget: DeleteTarget) => {
      commands
        .restoreBlocksByIds([deletedTarget.id])
        .then(unwrap)
        .then(() => {
          setResolveDeletedStatus(deletedTarget, false)
          // #3626 — the page is back; the calendar's cached journal-page
          // ranges predate the restore and would keep its dot hidden.
          invalidateCalendarPageDates()
          // #4007 — same story for the picker name caches, which dropped the
          // page on delete. A restore is the one mutation they can't fold in:
          // an EMPTY cache means "not fetched for this space yet", so
          // re-adding this one row would latch a one-row list as the whole
          // space (and the restore cascades to descendants besides). Drop
          // them and let the next picker read re-fetch. The title IS
          // available here (`deletedTarget.title`, used two lines up) — it is
          // the latch, not a missing title, that rules an insert out.
          invalidateNameCaches()
          deletedTarget.onRestored?.(deletedTarget.id)
          notify.success(t('pageDeleteAction.restored'))
        })
        .catch((err: unknown) => {
          logger.error(
            'usePageDeleteAction',
            'Failed to restore page',
            { pageId: deletedTarget.id },
            err,
          )
          notify.error(t('pageDeleteAction.restoreFailed'))
        })
    },
    [t],
  )

  const handleConfirm = useCallback(
    async function handleConfirm() {
      if (!target) return
      const { id, originSpaceId, onDeleted, onFailed } = target
      setDeletingId(id)
      try {
        const { block_id: canonicalSeedId, affected_page_ids: cascadedPageIds } = unwrap(
          await commands.deleteBlock(id),
        )
        setResolveDeletedStatus(target, true)
        // #4007 — the `[[` picker's page-name cache is filled once per space
        // and has no other delete signal; without this it keeps offering the
        // deleted page for the rest of the session.
        //
        // #4391 — `target.originSpaceId` (captured at `requestDelete` time,
        // same field `setResolveDeletedStatus` above already gates on) is the
        // space this delete belongs to, not whatever is active once the IPC
        // settles. `null` (space unhydrated when the dialog opened) falls back
        // to a full invalidation rather than silently dropping the removal.
        // Skipping would be equally correct; the "When the caller has NO active
        // space" section of `src/lib/name-change-bus.ts` is where that is
        // settled once for all the publishers.
        //
        // #4523 — the set to evict is NOT just `id`. `delete_block`'s cascade
        // walks `parent_id` with no page-boundary stop, so deleting a page
        // trashes its nested PAGE children too; the picker cache is keyed on
        // `list_all_pages_in_space` (`block_type = 'page' AND deleted_at IS
        // NULL AND space_id = ?`), so those children silently stopped being
        // real while the cache went on offering them — selecting one links to
        // a page in the trash. `affected_page_ids` is the cascade's page
        // membership, which only the backend can see; the frontend must not
        // re-derive it by walking the tree itself, because a second walk is
        // exactly how the two arms drift apart. This mirrors
        // `PageBrowserBatchToolbar.handleTrash` (#4480/#4521) one command over
        // — the single delete is the more common gesture of the two.
        //
        // The seed is published UNCONDITIONALLY. #4523 got that by unioning it
        // into the reported cohort; since #4558 split the call in two it is
        // structural instead — the seed IS the scoped cohort, so it goes out
        // whether or not the backend echoed it back inside
        // `affected_page_ids`, and a cohort that ever comes back narrower than
        // expected still cannot cost the seed its eviction. In the usual case,
        // where the backend does echo it, `notifyPagesRemoved` de-duplicates
        // the space-less cohort against the scoped one, so it is published
        // once rather than twice under two different scopes.
        //
        // The seed comes off the REPLY, not the caller's `id`. Both name the
        // same block, but `id` is whatever string the caller passed while
        // `block_id` is what the command normalised it to — `BlockId` is
        // uppercase on construction, so a caller handing in a lowercase ULID
        // would otherwise contribute an event keyed on a spelling no cache
        // entry uses, matching nothing. The cohort already carries the
        // canonical seed whenever the seed is a page; taking `block_id` keeps
        // the backstop above for the case where it is NOT a page, without the
        // spelling mismatch.
        //
        // No frontend test can tell the two apart: the mock's `delete_block`
        // handler echoes `block_id: blockId` verbatim
        // (`tauri-mock/handlers/blocks.ts`), so `resp.block_id === id` there by
        // construction. Normalisation happens in the command, and that is where
        // it is pinned — `delete_block_canonicalises_the_echoed_seed_id_4523`.
        // Asserting it from this hook against the mock would pass whether or
        // not this line is correct.
        //
        // `notifyPagesRemoved` (#4524, landed in #4534) owns the de-duplication,
        // the `NAME_CACHE_FANOUT_MAX_IDS` budget and the null-space fallback,
        // so this is the straight substitution session-1442 said it would be
        // once that publisher was on `main`. Measuring the budget against the
        // UNION rather than the one requested id is its behaviour, not this
        // caller's: the cascade is what makes this a set, so `1 <= budget`
        // would wave a 200-nested-page delete straight past the threshold the
        // budget exists to enforce.
        //
        // #4558 — cascade is space-less, see notifyPageRemoved.
        notifyPagesRemoved([canonicalSeedId], originSpaceId, cascadedPageIds)
        // #3626 — a deleted page must stop lighting up the calendar. The
        // journal's own DaySection routes its delete through here too, so this
        // one call covers every surface that can remove a journal page.
        invalidateCalendarPageDates()
        notify.success(t('pageDeleteAction.deleted'), {
          action: {
            label: t('pageDeleteAction.undo'),
            onClick: () => handleUndo(target),
          },
        })
        onDeleted?.(id)
      } catch (err) {
        logger.error('usePageDeleteAction', 'Failed to delete page', { pageId: id }, err)
        onFailed?.(id, err)
        notify.error(t('pageDeleteAction.deleteFailed'), {
          action: {
            label: t('pageDeleteAction.retry'),
            onClick: () => {
              handleConfirm().catch(() => {
                /* error already surfaced */
              })
            },
          },
        })
        // Re-throw so ConfirmDialog stays open per its async-rejection contract.
        throw err
      } finally {
        setDeletingId(null)
      }
    },
    [handleUndo, t, target],
  )

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) setTarget(null)
  }, [])

  const dialogTitleKey = target?.copy.titleKey ?? 'pageHeader.deletePageTitle'
  const dialogDescriptionKey = target?.copy.descriptionKey ?? 'pageHeader.deleteConfirm'
  const dialogConfirmKey = target?.copy.confirmKey ?? 'pageHeader.deletePage'
  const dialogCancelKey = target?.copy.cancelKey ?? 'pageHeader.cancel'
  const dialogValues = target?.copy.values ?? EMPTY_VALUES

  const confirmDialog = useMemo(
    () => (
      <ConfirmDialog
        open={target != null}
        onOpenChange={handleOpenChange}
        titleKey={dialogTitleKey}
        descriptionKey={dialogDescriptionKey}
        confirmKey={dialogConfirmKey}
        cancelKey={dialogCancelKey}
        values={dialogValues}
        variant="destructive"
        onConfirm={handleConfirm}
      />
    ),
    [
      dialogCancelKey,
      dialogConfirmKey,
      dialogDescriptionKey,
      dialogTitleKey,
      dialogValues,
      handleConfirm,
      handleOpenChange,
      target,
    ],
  )

  return {
    requestDelete,
    isDeleting: deletingId != null,
    deletingId,
    confirmDialog,
  }
}
