/**
 * usePropertyRowEditor — the containing hook for PropertyRowEditor.
 *
 * Owns the shared state and callbacks that the per-type editor components
 * (Text / Number / Date / Ref / Select / Boolean) consume through a thin
 * contract. Lifted from the original monolithic `PropertyRowEditor.tsx` as
 * Part of.
 *
 * The returned object is intentionally grouped by sub-feature
 * (`textState`, `dateState`, `selectOptionsState`, `refPickerState`) so each
 * typed editor only depends on its relevant slice.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { renameSelectOption } from '@/components/properties/notify-definition-write'
import {
  parseSelectOptions,
  readCurrentValue,
} from '@/components/properties/PropertyRowEditor/shared'
import { useDateInput } from '@/hooks/useDateInput'
import { type SelectOptionsEditorState, useSelectOptionsDraft } from '@/hooks/useSelectOptionsDraft'
import { reloadChangedPageStores } from '@/hooks/useSyncEvents'
import { unwrap } from '@/lib/app-error'
import type { PageHeading, PropertyDefinition, PropertyRow } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { matchesSearchFolded } from '@/lib/fold-for-search'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { invalidatePropertyCaches } from '@/lib/property-caches'
import { useSpaceStore } from '@/stores/space'

export interface UsePropertyRowEditorArgs {
  blockId: string
  prop: PropertyRow
  def: PropertyDefinition | undefined
  onSave: (rawValue: string) => void
  onDefUpdated?: ((updatedDef: PropertyDefinition) => void) | undefined
  onRefSaved?: (() => void) | undefined
  onCreateNewPage?: ((title: string) => void | Promise<void>) | undefined
  /**
   * #2792 — when true, `textLike.handleBlur` always calls `onSave` on blur,
   * even when the input value is unchanged from `currentValue`. Used for a
   * not-yet-persisted DRAFT row (see `PagePropertyTable.handleAddFromDef`):
   * such a row has no real "current value" to compare against, so the normal
   * unchanged-value skip would silently strand an untouched empty draft in
   * the UI forever instead of dropping it on blur (mirrors the drawer's
   * `PropertyField`, whose `onBlur` always fires unconditionally).
   */
  forceSaveOnBlur?: boolean | undefined
}

export interface TextLikeEditorState {
  localValue: string
  handleChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  handleBlur: () => void
}

export interface DateEditorState {
  dateInput: string
  datePreview: string | null
  handleChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  handleBlur: () => void
}

export interface SelectEditorState {
  localValue: string
  options: string[]
  handleSelectChange: (val: string) => void
}

export interface RefPickerEditorState {
  open: boolean
  setOpen: (v: boolean) => void
  search: string
  setSearch: (v: string) => void
  filteredPages: PageHeading[]
  savingRefPageId: string | null
  handleOpen: () => void
  handleSelectPage: (page: PageHeading) => Promise<void>
  handleCreateNewPage: () => Promise<void>
}

export interface UsePropertyRowEditorReturn {
  valueType: string
  currentValue: string
  textLike: TextLikeEditorState
  date: DateEditorState
  select: SelectEditorState
  selectOptions: SelectOptionsEditorState
  refPicker: RefPickerEditorState
}

/**
 * Build the shared state bag for a single PropertyRowEditor.
 *
 * All sub-state (text/date/select-options/ref-picker) lives here so the
 * orchestrator + typed editors can stay focused on rendering.
 */
export function usePropertyRowEditor({
  blockId,
  prop,
  def,
  onSave,
  onDefUpdated,
  onRefSaved,
  onCreateNewPage,
  forceSaveOnBlur,
}: UsePropertyRowEditorArgs): UsePropertyRowEditorReturn {
  const { t } = useTranslation()
  const valueType = def?.value_type ?? 'text'
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const currentValue = readCurrentValue(prop)

  const [localValue, setLocalValue] = useState(currentValue)

  // Sync localValue when prop changes externally
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- resyncs the local draft to the saved value; a plain derive would discard the user's edits; the guarded adjust is out of scope; see #4407
    setLocalValue(currentValue)
  }, [currentValue])

  // Date input hook — always called, values used only for date type
  const dateSave = useCallback(
    (isoDate: string) => {
      if (isoDate !== currentValue) onSave(isoDate)
    },
    [currentValue, onSave],
  )
  const {
    dateInput,
    datePreview,
    handleChange: handleDateChange,
    handleBlur: handleDateBlur,
  } = useDateInput({
    initialValue: currentValue,
    onSave: valueType === 'date' ? dateSave : undefined,
  })

  const handleBlur = useCallback(() => {
    if (valueType === 'date') {
      // Parsing an untouched value that doesn't fit would rewrite it, "next friday" into a date.
      if (dateInput.trim() !== currentValue) handleDateBlur()
      return
    }
    if (forceSaveOnBlur || localValue !== currentValue) {
      onSave(localValue)
    }
  }, [localValue, currentValue, onSave, valueType, handleDateBlur, dateInput, forceSaveOnBlur])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (valueType === 'date') {
        handleDateChange(e)
      } else {
        setLocalValue(e.target.value)
      }
    },
    [valueType, handleDateChange],
  )

  const handleSelectChange = useCallback(
    (val: string) => {
      const resolved = val === '__none__' ? '' : val
      setLocalValue(resolved)
      onSave(resolved)
    },
    [onSave],
  )

  const options = useMemo(() => parseSelectOptions(def), [def])

  // --- Edit select options popover state ---
  const saveOptions = useCallback(
    async (next: string[]) => {
      if (!def || currentSpaceId === null) return false
      try {
        const updatedDef = unwrap(
          await commands.updatePropertyDefOptions(currentSpaceId, def.key, JSON.stringify(next)),
        )
        onDefUpdated?.(updatedDef)
        // The options decide which of the key's values fit, wherever they show.
        invalidatePropertyCaches()
        return true
      } catch (err) {
        logger.error('PropertyRowEditor', 'Failed to update select options', { key: def.key }, err)
        notify.error(t('pageProperty.updateOptionsFailed'))
        return false
      }
    },
    [def, currentSpaceId, onDefUpdated, t],
  )

  // #5841 — a rename reaches every block of the space, so the open page's
  // values are read again, and the definition after the rename or its undo.
  // Its op is the space's, so no page's undo or redo moves.
  const renameOption = useCallback(
    async (from: string, to: string) => {
      if (!def || currentSpaceId === null) return false
      const spaceId = currentSpaceId
      const { key } = def
      const changed = (): void => {
        reloadChangedPageStores(undefined, { reanchorUndo: false })
        commands
          .getPropertyDef(spaceId, key)
          .then(unwrap)
          .then((fresh) => {
            if (fresh) onDefUpdated?.(fresh)
          })
          .catch((err: unknown) => {
            logger.warn(
              'PropertyRowEditor',
              'Failed to reload the renamed definition',
              { key },
              err,
            )
          })
      }
      return renameSelectOption(spaceId, key, from, to, changed)
    },
    [def, currentSpaceId, onDefUpdated],
  )

  const selectOptions = useSelectOptionsDraft(options, {
    save: saveOptions,
    rename: renameOption,
  })

  // --- Ref picker popover state ---
  const [refPickerOpen, setRefPickerOpen] = useState(false)
  const [refPages, setRefPages] = useState<PageHeading[]>([])
  const [refSearch, setRefSearch] = useState('')
  /** sub-fix 8 — id of the page currently being saved, or null. */
  const [savingRefPageId, setSavingRefPageId] = useState<string | null>(null)

  const handleOpenRefPicker = useCallback(() => {
    setRefSearch('')
    // The `<Popover>` above is controlled via `refPickerOpen`
    // but `<PopoverTrigger asChild>` makes Radix call `onOpenChange(true)`
    // on the trigger button's click before this handler runs, so the
    // popover is already open when we get here. The fix is twofold:
    // (1) reaffirm `setRefPickerOpen(true)` only after a successful
    // load so the open state is stable on success (also clears any
    // half-mounted state from a prior fast-rejection); (2) on rejection
    // close the popover explicitly so the user doesn't stare at an
    // empty page-picker list with no indication that the load failed.
    // The toast + `logger.error` on the catch path remains the only
    // failure surface the user sees.
    // b1 — `listAllPagesInSpace` is required-active. With no active space
    // there are no pages to pick, so short-circuit locally to an empty
    // picker instead of dispatching (a Global scope is rejected by the
    // backend).  `listAllPagesInSpace` has no clamp (the ref picker filters
    // client-side), so any workspace size shows up correctly here.
    if (currentSpaceId == null) {
      setRefPages([])
      setRefPickerOpen(true)
      return
    }
    commands
      .listAllPagesInSpace({ kind: 'active', space_id: currentSpaceId }, null)
      .then(unwrap)
      .then((pages) => {
        setRefPages(pages)
        setRefPickerOpen(true)
      })
      .catch((err: unknown) => {
        logger.error('PropertyRowEditor', 'Failed to load pages for ref picker', undefined, err)
        notify.error(t('pageProperty.loadPagesFailed'))
        setRefPages([])
        setRefPickerOpen(false)
      })
  }, [t, currentSpaceId])

  const filteredRefPages = useMemo(() => {
    if (!refSearch) return refPages
    // Unicode-aware fold.
    return refPages.filter((p) => matchesSearchFolded(p.content || '', refSearch))
  }, [refPages, refSearch])

  const handleSelectRefPage = useCallback(
    async (page: PageHeading) => {
      // Sub-fix 8 — show a Spinner gated on the same Promise as the
      // save so it never sticks if the IPC call rejects.
      setSavingRefPageId(page.id)
      try {
        unwrap(
          await commands.setProperty(blockId, prop.key, {
            value_text: null,
            value_num: null,
            value_date: null,
            value_ref: page.id,
            value_bool: null,
          }),
        )
        onRefSaved?.()
        setRefPickerOpen(false)
      } catch (err) {
        logger.error(
          'PropertyRowEditor',
          'Failed to save ref property',
          {
            blockId,
            key: prop.key,
          },
          err,
        )
        notify.error(t('pageProperty.saveFailed'))
      } finally {
        setSavingRefPageId(null)
      }
    },
    [blockId, prop.key, onRefSaved, t],
  )

  const handleCreateNewPage = useCallback(async () => {
    if (!onCreateNewPage) return
    const title = refSearch.trim()
    if (!title) return
    try {
      await onCreateNewPage(title)
      setRefPickerOpen(false)
    } catch (err) {
      logger.error(
        'PropertyRowEditor',
        'Failed to create page from ref picker',
        { blockId, key: prop.key, title },
        err,
      )
      notify.error(t('pageProperty.saveFailed'))
    }
  }, [onCreateNewPage, refSearch, blockId, prop.key, t])

  return {
    valueType,
    currentValue,
    textLike: { localValue, handleChange, handleBlur },
    date: {
      dateInput,
      datePreview,
      handleChange,
      handleBlur,
    },
    select: { localValue, options, handleSelectChange },
    selectOptions,
    refPicker: {
      open: refPickerOpen,
      setOpen: setRefPickerOpen,
      search: refSearch,
      setSearch: setRefSearch,
      filteredPages: filteredRefPages,
      savingRefPageId,
      handleOpen: handleOpenRefPicker,
      handleSelectPage: handleSelectRefPage,
      handleCreateNewPage,
    },
  }
}
