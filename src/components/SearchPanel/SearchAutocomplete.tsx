/**
 * SearchAutocomplete — the caret-anchored autocomplete subsystem,
 * extracted from SearchPanel.
 *
 * PEND-58f FE-10 — caret position only matters to the autocomplete
 * anchor, yet it was SearchPanel state, so every keyup/click/select/
 * focus re-rendered the ~1100-line panel. Owning `caretPos` (and the
 * whole autocomplete state machine) here means caret moves re-render
 * only this small component. SearchPanel learns about open/aria changes
 * via `onStateChange` (infrequent) and delegates the relevant keystrokes
 * through the imperative `handleKeyDown` handle.
 *
 * PEND-58g NEW-1 — the anchor is computed unconditionally from the query
 * and caret; there is no `suppressed` gate. `detectAutocompleteAnchor`
 * already returns `null` for free-text / quoted / non-prefix tokens, so
 * the free-text remainder (including the regex remainder in regex mode)
 * is self-suppressing, while recognized filter prefixes (`tag:`, `path:`,
 * …) still open the popover — even in regex mode, where those structural
 * filters apply too.
 */
import type React from 'react'
import { useEffect, useImperativeHandle, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  type AutocompleteAriaIds,
  AutocompletePopover,
} from '@/components/search/AutocompletePopover'
import { useAutocompleteSources } from '@/hooks/useAutocompleteSources'
import { getCaretRect } from '@/lib/caret-anchor'
import {
  type AutocompleteAnchor,
  applyAutocompleteReplacement,
  detectAutocompleteAnchor,
} from '@/lib/search-query/autocomplete'

export interface SearchAutocompleteState {
  open: boolean
  ariaIds: AutocompleteAriaIds | null
}

export interface SearchAutocompleteHandle {
  /**
   * Handle a keydown on the owning input. Returns `true` if the
   * autocomplete consumed it (caller must then stop), `false` otherwise.
   */
  handleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => boolean
  /**
   * Eagerly sync the caret on input change (the parent's `onChange` has
   * the authoritative caret). Keeps the anchor in lockstep with the value
   * for `fill()`-style updates that fire no `keyup`.
   */
  syncCaret: (pos: number) => void
}

interface SearchAutocompleteProps {
  inputRef: React.RefObject<HTMLInputElement | null>
  query: string
  spaceId: string | null
  focused: boolean
  /** Shared with SearchPanel's `setQueryAndCaret`; consumed on query change. */
  pendingCaretRef: React.RefObject<number | null>
  /** Apply a chosen completion (SearchPanel owns the query + debounce). */
  onApply: (nextValue: string, nextCaret: number) => void
  /** Report open / aria-id changes so SearchPanel can wire combobox attrs. */
  onStateChange: (state: SearchAutocompleteState) => void
  /** React 19 — ref is passed as a plain prop, not via a ref-forwarding HOC. */
  ref?: React.Ref<SearchAutocompleteHandle>
}

export function SearchAutocomplete({
  inputRef,
  query,
  spaceId,
  focused,
  pendingCaretRef,
  onApply,
  onStateChange,
  ref,
}: SearchAutocompleteProps): React.ReactElement {
  const { t } = useTranslation()
  const [caretPos, setCaretPos] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [ariaIds, setAriaIds] = useState<AutocompleteAriaIds | null>(null)

  const anchor = useMemo<AutocompleteAnchor>(
    () => detectAutocompleteAnchor(query, caretPos),
    [query, caretPos],
  )
  const { items, loading } = useAutocompleteSources({ anchor, spaceId })
  const open = focused && !dismissed && anchor != null && (items.length > 0 || loading)

  // Caret tracker. `onChange` (typing) syncs via the `[query]` effect
  // below; these native listeners cover arrow moves, clicks, selection
  // drags, and focus.
  useEffect(() => {
    const input = inputRef.current
    if (input == null) return
    const sync = () => setCaretPos(input.selectionStart ?? input.value.length)
    input.addEventListener('select', sync)
    input.addEventListener('keyup', sync)
    input.addEventListener('click', sync)
    input.addEventListener('focus', sync)
    return () => {
      input.removeEventListener('select', sync)
      input.removeEventListener('keyup', sync)
      input.removeEventListener('click', sync)
      input.removeEventListener('focus', sync)
    }
  }, [inputRef])

  // On every query change: apply a pending caret from an external
  // `setQueryAndCaret` (history recall, chip add, completion apply),
  // otherwise sync the caret from the freshly-committed input value
  // (covers typing). Also re-arm dismissal so typing re-opens.
  // `query` is the real trigger (read the input post-commit); `inputRef`
  // and `pendingCaretRef` are stable RefObject props so listing them is a
  // no-op for re-runs — same pattern as the caret-tracker effect above.
  useEffect(() => {
    setDismissed(false)
    const input = inputRef.current
    if (input == null) return
    if (pendingCaretRef.current != null) {
      const pos = pendingCaretRef.current
      input.setSelectionRange(pos, pos)
      setCaretPos(pos)
      pendingCaretRef.current = null
    } else {
      setCaretPos(input.selectionStart ?? query.length)
    }
  }, [query, inputRef, pendingCaretRef])

  // Default the highlight to the first item; keep a surviving selection.
  useEffect(() => {
    if (!open) {
      setSelected(null)
      return
    }
    setSelected((prev) =>
      prev != null && items.some((i) => i.value === prev) ? prev : (items[0]?.value ?? null),
    )
  }, [open, items])

  // Anchor the popover to the start of the value portion.
  useEffect(() => {
    if (!open || anchor == null) {
      setRect(null)
      return
    }
    const input = inputRef.current
    if (input == null) return
    setRect(getCaretRect(input, anchor.anchor))
  }, [open, anchor, inputRef])

  // Report open / aria changes up (infrequent — never per-caret).
  useEffect(() => {
    onStateChange({ open, ariaIds })
  }, [open, ariaIds, onStateChange])

  const applySelection = (value: string) => {
    if (anchor == null) return
    const { nextValue, nextCaret } = applyAutocompleteReplacement(query, caretPos, anchor, value)
    setSelected(null)
    setDismissed(true)
    onApply(nextValue, nextCaret)
  }

  useImperativeHandle(ref, () => ({
    syncCaret: (pos: number) => setCaretPos(pos),
    handleKeyDown: (e) => {
      if (!open || items.length === 0) return false
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        moveHighlight(1)
        return true
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        moveHighlight(-1)
        return true
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && selected != null) {
        e.preventDefault()
        applySelection(selected)
        return true
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissed(true)
        setSelected(null)
        return true
      }
      return false
    },
  }))

  function moveHighlight(direction: 1 | -1) {
    if (items.length === 0) return
    const idx = selected != null ? items.findIndex((it) => it.value === selected) : -1
    const startIdx = idx === -1 ? (direction > 0 ? -1 : 0) : idx
    const nextIdx = (startIdx + direction + items.length) % items.length
    const next = items[nextIdx]
    if (next) setSelected(next.value)
  }

  return (
    <AutocompletePopover
      open={open}
      anchorRect={rect}
      items={items}
      selectedValue={selected}
      onSelectedValueChange={setSelected}
      onSelect={applySelection}
      label={t('search.autocompleteListLabel')}
      loading={loading}
      loadingLabel={t('search.searching')}
      onAriaIdsChange={setAriaIds}
    />
  )
}
