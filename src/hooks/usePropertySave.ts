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
import { toast } from 'sonner'
import { announce } from '@/lib/announcer'
import { logger } from '@/lib/logger'
import { handleDeleteProperty, handleSaveProperty } from '@/lib/property-save-utils'
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
          toast.error(t(toasts?.invalidNumber ?? 'property.invalidNumber'))
          return
        }
        if (announceOnSave) {
          announce(t(announceOnSave))
        }
      } catch (err) {
        if (logTag) {
          logger.error(logTag, 'Failed to save property', {
            blockId: blockId ?? '',
            key,
            error: String(err),
          })
        }
        toast.error(t(toasts?.saveFailed ?? 'property.saveFailed'))
      }
    },
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
          logger.error(logTag, 'Failed to delete property', {
            blockId: blockId ?? '',
            key,
            error: String(err),
          })
        }
        toast.error(t(toasts?.deleteFailed ?? 'property.deleteFailed'))
      }
    },
    [blockId, t, setProperties, toasts?.deleteFailed, announceOnDelete, logTag],
  )

  return { handleSave, handleDelete }
}
