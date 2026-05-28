/**
 * usePageAliases — page-alias CRUD state for `PageHeader`.
 *
 * Owns the alias list, the inline-edit input, the editing flag, the
 * initial fetch effect, and the add/remove handlers. Extracted from
 * `PageHeader.tsx` during the design-system maintainability pass
 * (Phase 3b) to keep the orchestrator lean.
 *
 * The persistence layer (`getPageAliases` / `setPageAliases`) and the
 * accessibility announcements (`announce`) live behind module imports
 * so the hook itself is render-only: tests render it with `renderHook`
 * and mock those modules.
 */

import { useCallback, useEffect, useState } from 'react'

import { announce } from '@/lib/announcer'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { getPageAliases, setPageAliases } from '@/lib/tauri'

export interface UsePageAliasesReturn {
  /** Current alias list (sorted in the order the user added them). */
  aliases: string[]
  /** Whether the inline editor is open. */
  editingAliases: boolean
  /** Current draft text in the alias input. */
  aliasInput: string
  /** Setter for the alias input draft. */
  setAliasInput: (value: string) => void
  /** Open the inline editor. */
  startEditing: () => void
  /** Close the inline editor. */
  stopEditing: () => void
  /** Append `aliasInput` (trimmed) and persist; no-op when blank. */
  handleAddAlias: () => void
  /** Remove an alias and persist. */
  handleRemoveAlias: (alias: string) => void
}

/**
 * Hook for managing the alias list of a single page. Fetches once per
 * `pageId` and reuses the same persistence helpers as the previous
 * inline implementation, including the same toast/announcer wiring.
 *
 * `t` is the `react-i18next` translator. Callers pass it through so the
 * hook stays framework-agnostic at the import boundary (it doesn't pull
 * in `useTranslation` itself, which would force every renderHook test
 * to wrap with `I18nextProvider`).
 */
export function usePageAliases(pageId: string, t: (key: string) => string): UsePageAliasesReturn {
  const [aliases, setAliases] = useState<string[]>([])
  const [editingAliases, setEditingAliases] = useState(false)
  const [aliasInput, setAliasInput] = useState('')

  // Fetch aliases on mount / page change. Tolerates non-array backend
  // payloads (older SQLite migrations stored aliases as a JSON blob and
  // a few rows may still return `null` until they're rewritten).
  useEffect(() => {
    if (!pageId) return
    getPageAliases(pageId)
      .then((result) => setAliases(Array.isArray(result) ? result : []))
      .catch((err: unknown) => {
        logger.error('PageHeader', 'Failed to load page aliases', { pageId }, err)
        notify.error(t('pageHeader.loadAliasesFailed'))
      })
  }, [pageId, t])

  const startEditing = useCallback(() => setEditingAliases(true), [])
  const stopEditing = useCallback(() => setEditingAliases(false), [])

  const handleAddAlias = useCallback(() => {
    if (aliasInput.trim()) {
      const next = [...aliases, aliasInput.trim()]
      setAliases(next)
      announce(t('announce.aliasAdded'))
      setPageAliases(pageId, next).catch((err: unknown) => {
        logger.error('PageHeader', 'Failed to update page aliases', { pageId }, err)
        notify.error(t('pageHeader.aliasUpdateFailed'))
        announce(t('announce.aliasFailed'))
      })
      setAliasInput('')
    }
  }, [aliasInput, aliases, pageId, t])

  const handleRemoveAlias = useCallback(
    (alias: string) => {
      const next = aliases.filter((a) => a !== alias)
      setAliases(next)
      announce(t('announce.aliasRemoved'))
      setPageAliases(pageId, next).catch((err: unknown) => {
        logger.error('PageHeader', 'Failed to update page aliases', { pageId }, err)
        notify.error(t('pageHeader.aliasUpdateFailed'))
        announce(t('announce.aliasFailed'))
      })
    },
    [aliases, pageId, t],
  )

  return {
    aliases,
    editingAliases,
    aliasInput,
    setAliasInput,
    startEditing,
    stopEditing,
    handleAddAlias,
    handleRemoveAlias,
  }
}
