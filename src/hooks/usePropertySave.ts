/**
 * usePropertySave -- shared save / delete hook with toast notifications.
 *
 * Encapsulates the common pattern used by BlockPropertyDrawer and
 * PagePropertyTable: call handleSaveProperty / handleDeleteProperty,
 * show a toast on error, and optionally announce for screen readers.
 */

import type { Dispatch, SetStateAction } from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { announce } from '@/lib/announcer'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { handleDeleteProperty, handleSaveProperty } from '@/lib/property-save-utils'
import { invalidRepeatRuleMessage } from '@/lib/repeat-utils'
import type { PropertyRow } from '@/lib/tauri'

export interface UsePropertySaveOptions {
  /** Block or page ID to operate on. When null, save/delete are no-ops. */
  blockId: string | null
  /** React state setter for the property list. */
  setProperties: Dispatch<SetStateAction<PropertyRow[]>>
  /** Override default i18n keys for toast messages. */
  toasts?: {
    invalidNumber?: string
    saveFailed?: string
    deleteFailed?: string
  }
  /** i18n key announced to screen readers after a successful save. */
  announceOnSave?: string
  /** i18n key announced to screen readers after a successful delete. */
  announceOnDelete?: string
  /** When provided, errors are logged via logger.error(logTag, ...). */
  logTag?: string
}

export interface UsePropertySaveReturn {
  handleSave: (key: string, value: string, type: string) => Promise<void>
  handleDelete: (key: string) => Promise<void>
}

export function usePropertySave({
  blockId,
  setProperties,
  toasts,
  announceOnSave,
  announceOnDelete,
  logTag,
}: UsePropertySaveOptions): UsePropertySaveReturn {
  const { t } = useTranslation()

  const handleSave = useCallback(
    async (key: string, value: string, type: string) => {
      if (!blockId) return
      try {
        const ok = await handleSaveProperty(blockId, key, value, type, (props) =>
          setProperties(props),
        )
        if (!ok) {
          notify.error(t(toasts?.invalidNumber ?? 'property.invalidNumber'))
          return
        }
        if (announceOnSave) {
          announce(t(announceOnSave))
        }
      } catch (err) {
        if (logTag) {
          logger.error(
            logTag,
            'Failed to save property',
            {
              blockId,
              key,
            },
            err,
          )
        }
        // #3647 — a malformed `repeat` rule is now rejected by the backend at
        // the point of entry, and the rejection says WHAT is wrong with the
        // rule. Show that verbatim: collapsing it into the generic
        // "Failed to save property" toast would put the user back where they
        // started, which is the whole failure mode the validation removed.
        const repeatReason = invalidRepeatRuleMessage(err)
        notify.error(repeatReason ?? t(toasts?.saveFailed ?? 'property.saveFailed'))
      }
    },
    // oxlint-disable-next-line react/preserve-manual-memoization -- deliberately depends on individual `toasts` string fields, not the `toasts` object itself: src/components/pages/PagePropertyTable.tsx:113 passes a fresh `toasts` object literal on every render, so keying on the object identity (the dependency this rule reports as inferred) would rebuild handleSave/handleDelete on every render and defeat the memoization the property-level deps exist to preserve. Lint hygiene only, NOT Compiler reasoning: this file is `.ts`, outside the babel include in vite.config.ts (`/\.[jt]sx(?:$|\?)/`), so the React Compiler never processes it and this manual `useCallback` is the only memoization in play (#4409)
    [blockId, t, setProperties, toasts?.invalidNumber, toasts?.saveFailed, announceOnSave, logTag],
  )

  const handleDelete = useCallback(
    async (key: string) => {
      if (!blockId) return
      try {
        await handleDeleteProperty(blockId, key, () => {
          setProperties((prev) => prev.filter((p) => p.key !== key))
        })
        if (announceOnDelete) {
          announce(t(announceOnDelete))
        }
      } catch (err) {
        if (logTag) {
          logger.error(
            logTag,
            'Failed to delete property',
            {
              blockId,
              key,
            },
            err,
          )
        }
        notify.error(t(toasts?.deleteFailed ?? 'property.deleteFailed'))
      }
    },
    // No react/preserve-manual-memoization disable needed here (asymmetric
    // with handleSave, verified empirically): this callback reads exactly
    // ONE `toasts` field (`deleteFailed`), so the inferred dependency stays
    // that single property and matches the manual list below. handleSave
    // reads TWO distinct `toasts` fields (`invalidNumber` in an early-return
    // branch, `saveFailed` in the catch branch) — touching more than one
    // property of the same optional object across separate branches is what
    // widens the compiler's inference to the whole `toasts` object, which is
    // what triggers the mismatch there. Confirmed by mirroring handleSave's
    // two-field, two-branch shape onto this callback: the same error then
    // reproduces here too.
    [blockId, t, setProperties, toasts?.deleteFailed, announceOnDelete, logTag],
  )

  return { handleSave, handleDelete }
}
