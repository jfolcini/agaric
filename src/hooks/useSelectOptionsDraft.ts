/**
 * useSelectOptionsDraft — the draft a select's options editor works on: add,
 * remove and reorder locally, then Save writes the whole list. A rename, when
 * the caller offers one, is written at once (it renames the values blocks
 * hold too), so the draft follows it rather than waiting for Save.
 */

import { useCallback, useState } from 'react'

export interface SelectOptionsDraftActions {
  /** Write `options`; resolves whether the write succeeded. */
  save: (options: string[]) => Promise<boolean>
  /** Rename the saved option `from` to `to`; resolves whether it succeeded. */
  rename?: ((from: string, to: string) => Promise<boolean>) | undefined
}

export interface SelectOptionsEditorState {
  open: boolean
  setOpen: (v: boolean) => void
  /** The options as stored, which a rename applies to. */
  saved: readonly string[]
  /** The draft. */
  options: string[]
  newOptionInput: string
  setNewOptionInput: (v: string) => void
  canAddOption: boolean
  handleOpen: () => void
  handleAdd: () => void
  handleRemove: (opt: string) => void
  handleMove: (opt: string, direction: 'up' | 'down') => void
  handleSave: () => Promise<void>
  handleRename: ((from: string, to: string) => Promise<boolean>) | null
}

export function useSelectOptionsDraft(
  saved: readonly string[],
  actions: SelectOptionsDraftActions,
): SelectOptionsEditorState {
  const { save, rename } = actions
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<string[]>([])
  const [newOptionInput, setNewOptionInput] = useState('')

  const handleOpen = useCallback(() => {
    setOptions([...saved])
    setNewOptionInput('')
    setOpen(true)
  }, [saved])

  const handleRemove = useCallback((opt: string) => {
    setOptions((prev) => prev.filter((o) => o !== opt))
  }, [])

  const handleMove = useCallback((opt: string, direction: 'up' | 'down') => {
    setOptions((prev) => {
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

  const handleAdd = useCallback(() => {
    const trimmed = newOptionInput.trim()
    if (!trimmed) return
    setOptions((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]))
    setNewOptionInput('')
  }, [newOptionInput])

  const handleSave = useCallback(async () => {
    if (await save(options)) setOpen(false)
  }, [save, options])

  const renameOption = useCallback(
    async (from: string, to: string) => {
      if (!rename || !(await rename(from, to))) return false
      // A pending add of the same name would now be a duplicate of the renamed option.
      setOptions((prev) => prev.filter((o) => o !== to).map((o) => (o === from ? to : o)))
      return true
    },
    [rename],
  )

  return {
    open,
    setOpen,
    saved,
    options,
    newOptionInput,
    setNewOptionInput,
    canAddOption: newOptionInput.trim().length > 0,
    handleOpen,
    handleAdd,
    handleRemove,
    handleMove,
    handleSave,
    handleRename: rename ? renameOption : null,
  }
}
