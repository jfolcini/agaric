/**
 * usePropertyRowEditor — the containing hook for PropertyRowEditor.
 *
 * Owns the shared state and callbacks that the per-type editor components
 * (Text / Number / Date / Ref / Select / Boolean) consume through a thin
 * contract. Lifted from the original monolithic `PropertyRowEditor.tsx` as
 * part of MAINT-128.
 *
 * The returned object is intentionally grouped by sub-feature
 * (`textState`, `dateState`, `selectOptionsState`, `refPickerState`) so each
 * typed editor only depends on its relevant slice.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { matchesSearchFolded } from '@/lib/fold-for-search'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

import { useDateInput } from '../../hooks/useDateInput'
import { setPriorityLevels } from '../../lib/priority-levels'
import type { PageHeading, PropertyDefinition, PropertyRow } from '../../lib/tauri'
import { listAllPagesInSpace, setProperty, updatePropertyDefOptions } from '../../lib/tauri'
import { useSpaceStore } from '../../stores/space'
import { parseSelectOptions, readCurrentValue } from './shared'

export interface UsePropertyRowEditorArgs {
  blockId: string
  prop: PropertyRow
  def: PropertyDefinition | undefined
  onSave: (rawValue: string) => void
  onDefUpdated?: ((updatedDef: PropertyDefinition) => void) | undefined
  onRefSaved?: (() => void) | undefined
  onCreateNewPage?: ((title: string) => void | Promise<void>) | undefined
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

export interface SelectOptionsEditorState {
  open: boolean
  setOpen: (v: boolean) => void
  options: string[]
  newOptionInput: string
  setNewOptionInput: (v: string) => void
  canAddOption: boolean
  handleOpen: () => void
  handleAdd: () => void
  handleRemove: (opt: string) => void
  handleMove: (opt: string, direction: 'up' | 'down') => void
  handleSave: () => Promise<void>
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
}: UsePropertyRowEditorArgs): UsePropertyRowEditorReturn {
  const { t } = useTranslation()
  const valueType = def?.value_type ?? 'text'
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const currentValue = readCurrentValue(prop)

  const [localValue, setLocalValue] = useState(currentValue)

  // Sync localValue when prop changes externally
  useEffect(() => {
    setLocalValue(currentValue)
  }, [currentValue])

  // Date input hook (M-29) — always called, values used only for date type
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
      handleDateBlur()
      return
    }
    if (localValue !== currentValue) {
      onSave(localValue)
    }
  }, [localValue, currentValue, onSave, valueType, handleDateBlur])

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
  const [editOptionsOpen, setEditOptionsOpen] = useState(false)
  const [editingOptions, setEditingOptions] = useState<string[]>([])
  const [newOptionInput, setNewOptionInput] = useState('')

  const handleOpenEditOptions = useCallback(() => {
    setEditingOptions([...options])
    setNewOptionInput('')
    setEditOptionsOpen(true)
  }, [options])

  const handleRemoveOption = useCallback((opt: string) => {
    setEditingOptions((prev) => prev.filter((o) => o !== opt))
  }, [])

  const handleMoveOption = useCallback((opt: string, direction: 'up' | 'down') => {
    setEditingOptions((prev) => {
      const idx = prev.indexOf(opt)
      if (idx === -1) return prev
      const targetIdx = direction === 'up' ? idx - 1 : idx + 1
      if (targetIdx < 0 || targetIdx >= prev.length) return prev
      const next = [...prev]
      const tmp = next[idx] as string
      next[idx] = next[targetIdx] as string
      next[targetIdx] = tmp
      return next
    })
  }, [])

  const handleAddOption = useCallback(() => {
    const trimmed = newOptionInput.trim()
    if (!trimmed) return
    setEditingOptions((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]))
    setNewOptionInput('')
  }, [newOptionInput])

  const canAddOption = newOptionInput.trim().length > 0

  const handleSaveOptions = useCallback(async () => {
    if (!def) return
    try {
      const updatedDef = await updatePropertyDefOptions(def.key, JSON.stringify(editingOptions))
      onDefUpdated?.(updatedDef)
      setEditOptionsOpen(false)
      // UX-201b: keep the priority-levels cache in sync when editing the
      // `priority` definition from the block-level editor.
      if (def.key === 'priority') {
        const levels = editingOptions.filter((v) => typeof v === 'string' && v.trim() !== '')
        if (levels.length > 0) setPriorityLevels(levels)
      }
    } catch (err) {
      logger.error(
        'PropertyRowEditor',
        'Failed to update select options',
        {
          key: def?.key ?? '',
        },
        err,
      )
      notify.error(t('pageProperty.updateOptionsFailed'))
    }
  }, [def, editingOptions, onDefUpdated, t])

  // --- Ref picker popover state ---
  const [refPickerOpen, setRefPickerOpen] = useState(false)
  const [refPages, setRefPages] = useState<PageHeading[]>([])
  const [refSearch, setRefSearch] = useState('')
  /** UX-272 sub-fix 8 — id of the page currently being saved, or null. */
  const [savingRefPageId, setSavingRefPageId] = useState<string | null>(null)

  const handleOpenRefPicker = useCallback(() => {
    setRefSearch('')
    // MAINT-181: the `<Popover>` above is controlled via `refPickerOpen`
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
    // FEAT-3 Phase 4 — `listAllPagesInSpace` requires `spaceId`.  The
    // `?? ''` fallback is intentional pre-bootstrap behaviour: empty
    // string forces a no-match SQL filter rather than a runtime null
    // deref.  `listAllPagesInSpace` has no clamp (the ref picker filters
    // client-side), so any workspace size shows up correctly here.
    listAllPagesInSpace(currentSpaceId ?? '')
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
    // UX-248 — Unicode-aware fold.
    return refPages.filter((p) => matchesSearchFolded(p.content || '', refSearch))
  }, [refPages, refSearch])

  const handleSelectRefPage = useCallback(
    async (page: PageHeading) => {
      // UX-272 sub-fix 8 — show a Spinner gated on the same Promise as the
      // save so it never sticks if the IPC call rejects.
      setSavingRefPageId(page.id)
      try {
        await setProperty({ blockId, key: prop.key, valueRef: page.id })
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
    selectOptions: {
      open: editOptionsOpen,
      setOpen: setEditOptionsOpen,
      options: editingOptions,
      newOptionInput,
      setNewOptionInput,
      canAddOption,
      handleOpen: handleOpenEditOptions,
      handleAdd: handleAddOption,
      handleRemove: handleRemoveOption,
      handleMove: handleMoveOption,
      handleSave: handleSaveOptions,
    },
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
