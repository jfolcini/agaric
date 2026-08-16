/**
 * BlockPropertyEditor — inline edit popup for block properties.
 *
 * Renders the popup as a React portal anchored to a 0×0 placeholder
 * sibling and positions it with `@floating-ui/dom` (`computePosition` +
 * `autoUpdate`). This mirrors `suggestion-renderer.ts` so the popup escapes
 * `overflow: hidden` ancestors and reflows on scroll/resize. The portal carries
 * `data-editor-portal` so `EDITOR_PORTAL_SELECTORS` (see `useEditorBlur.ts`)
 * recognises it as transient editor UI and does not blur the surrounding block.
 */

import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import type React from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { ScrollArea } from '@/components/ui/scroll-area'
import { unwrap } from '@/lib/app-error'
import type { BlockRow, PropertyRow } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { applySafePosition } from '@/lib/floating-position'
import { matchesSearchFolded } from '@/lib/fold-for-search'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import {
  buildPropertyParams,
  carriedRenameDefinition,
  COLUMN_BACKED_PROPERTY_KEYS,
  NON_DELETABLE_PROPERTIES,
} from '@/lib/property-save-utils'
import { reportIpcError } from '@/lib/report-ipc-error'
import { cn } from '@/lib/utils'

export interface BlockPropertyEditorProps {
  blockId: string
  editingProp: { key: string; value: string } | null
  setEditingProp: (prop: { key: string; value: string } | null) => void
  editingKey: { oldKey: string; value: string } | null
  setEditingKey: (keyInfo: { oldKey: string; value: string } | null) => void
  selectOptions: string[] | null
  isRefProp: boolean
  refPages: BlockRow[]
  refSearch: string
  setRefSearch: (search: string) => void
  /**
   * The value type of `editingProp`'s property (from
   * `usePropertyDefForEdit`), e.g. `'text' | 'number' | 'date' | 'boolean'`,
   * or `null` while the definition for THIS key has not resolved yet.
   * #3275 — routes the plain-text-input commit through
   * `buildPropertyParams` (the same function the drawer path uses) so a
   * user-defined `number`/`date` property keeps its typed column instead of
   * being flattened into `value_text` with every other column nulled.
   *
   * `null` never means "commit against whatever type is lying around": the
   * lookup is per-key and asynchronous, so an assumed type would be a type
   * resolved for a DIFFERENT key. #4009 — instead of discarding the edit,
   * the text input's `onBlur` resolves the definition for its OWN key before
   * committing, so a definition that lands late costs a moment rather than
   * the text the user just typed. Only a lookup that actually FAILS aborts.
   */
  valueType: string | null
}

/** Placeholder offsets used while the popup is mounted but before the first
 *  `computePosition` call resolves — keeps it off-screen to prevent a flash
 *  at (0, 0). Mirrors the pattern in `suggestion-renderer.ts`. */
const HIDDEN_LEFT = '-9999px'
const HIDDEN_TOP = '-9999px'

export function BlockPropertyEditor({
  blockId,
  editingProp,
  setEditingProp,
  editingKey,
  setEditingKey,
  selectOptions,
  isRefProp,
  refPages,
  refSearch,
  setRefSearch,
  valueType,
}: BlockPropertyEditorProps): React.ReactElement | null {
  const { t } = useTranslation()

  const propAnchorRef = useRef<HTMLSpanElement | null>(null)
  const propPopupRef = useRef<HTMLDivElement | null>(null)
  const keyAnchorRef = useRef<HTMLSpanElement | null>(null)
  const keyPopupRef = useRef<HTMLDivElement | null>(null)
  // Stable id base for select-options listbox so each option
  // can carry a unique `id` referenced by `aria-activedescendant`.
  const selectListboxId = useId()

  // #976 (item 10) — keyboard navigation for the select-options listbox. The
  // listbox previously carried `aria-activedescendant`/`aria-selected` ARIA but
  // ZERO key handlers, so AT users had to Tab through every option (the comment
  // promised it mirrored `TagValuePicker` but omitted its Arrow/Home/End/Enter
  // logic). `activeIndex` is the keyboard-navigated row; it seeds to the
  // selected option (or 0) when the listbox opens and drives
  // `aria-activedescendant`. The option `<button>`s also get
  // `focus-ring-visible` (#976 item 11) so the row is visible while navigating.
  const [activeIndex, setActiveIndex] = useState(-1)
  const selectListRef = useRef<HTMLDivElement | null>(null)

  // Seed/reset the active option whenever the select-options popup opens for a
  // (new) property. Start on the currently-selected value, else the first row.
  useEffect(() => {
    if (!editingProp || !selectOptions) {
      setActiveIndex(-1)
      return
    }
    const selectedIdx = selectOptions.indexOf(editingProp.value)
    setActiveIndex(Math.max(selectedIdx, 0))
  }, [editingProp, selectOptions])

  // Keep the keyboard-active option scrolled into view as the user navigates,
  // mirroring `TagValuePicker.tsx`.
  useEffect(() => {
    if (activeIndex >= 0 && selectListRef.current) {
      const option = selectListRef.current.children[activeIndex] as HTMLElement | undefined
      if (typeof option?.scrollIntoView === 'function') {
        option.scrollIntoView({ block: 'nearest' })
      }
    }
  }, [activeIndex])

  // Commit a select option (shared by click + Enter). Awaits the IPC, reports
  // failures, then closes the popup — identical to the per-option onClick.
  const commitSelectOption = useCallback(
    async (opt: string): Promise<void> => {
      if (!editingProp) return
      try {
        unwrap(
          await commands.setProperty(blockId, editingProp.key, {
            value_text: opt,
            value_num: null,
            value_date: null,
            value_ref: null,
            value_bool: null,
          }),
        )
      } catch (err) {
        reportIpcError('BlockPropertyEditor', 'property.saveFailed', err, t, {
          blockId,
          key: editingProp.key,
        })
      }
      setEditingProp(null)
    },
    [blockId, editingProp, setEditingProp, t],
  )

  const handleSelectListboxKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!selectOptions || selectOptions.length === 0) return
      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault()
          setActiveIndex((prev) => Math.min(prev + 1, selectOptions.length - 1))
          break
        }
        case 'ArrowUp': {
          e.preventDefault()
          setActiveIndex((prev) => Math.max(prev - 1, 0))
          break
        }
        case 'Home': {
          e.preventDefault()
          setActiveIndex(0)
          break
        }
        case 'End': {
          e.preventDefault()
          setActiveIndex(selectOptions.length - 1)
          break
        }
        case 'Enter': {
          const opt = selectOptions[activeIndex]
          if (activeIndex >= 0 && opt !== undefined) {
            e.preventDefault()
            void commitSelectOption(opt)
          }
          break
        }
      }
    },
    [selectOptions, activeIndex, commitSelectOption],
  )

  // ── Position + autoUpdate for the value popup ──────────────────────────
  useEffect(() => {
    if (!editingProp) return
    const anchor = propAnchorRef.current
    const popup = propPopupRef.current
    if (!anchor || !popup) {
      logger.warn('BlockPropertyEditor', 'value popup mounted without refs', {
        hasAnchor: anchor !== null,
        hasPopup: popup !== null,
        key: editingProp.key,
      })
      return
    }

    const update = () => {
      if (!anchor.isConnected || !popup.isConnected) {
        logger.warn('BlockPropertyEditor', 'anchor unmounted while value popup open', {
          key: editingProp.key,
          anchorConnected: anchor.isConnected,
          popupConnected: popup.isConnected,
        })
        return
      }
      computePosition(anchor, popup, {
        placement: 'bottom-start',
        middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
      })
        .then(({ x, y }) => {
          applySafePosition(popup, { x, y })
        })
        .catch((err: unknown) => {
          logger.warn(
            'BlockPropertyEditor',
            'value popup computePosition failed',
            { key: editingProp.key },
            err,
          )
          // Push popup off-screen on failure so it doesn't
          // float orphaned mid-page after the anchor scrolls or moves.
          applySafePosition(popup, null)
        })
    }

    return autoUpdate(anchor, popup, update)
  }, [editingProp])

  // ── Outside-click for the value popup ──────────────────────────────────
  useEffect(() => {
    if (!editingProp) return

    const handlePointerDown = (e: PointerEvent) => {
      const popup = propPopupRef.current
      const anchor = propAnchorRef.current
      if (!popup) return
      const target = e.target as Node | null
      if (!target) return
      if (popup.contains(target)) return
      if (anchor?.contains(target)) return
      setEditingProp(null)
    }

    // Escape closes the value popup. Handled at the document level (canonical
    // dialog dismissal) so it works regardless of which inner control — the
    // search input or any of the ref/select option buttons — has focus,
    // without hanging a keyboard listener on the non-interactive grouping
    // element (jsx-a11y/no-noninteractive-element-interactions).
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEditingProp(null)
    }

    // Defer registration by a frame so the click that opened the popup
    // doesn't immediately close it (mirrors suggestion-renderer.ts).
    let frameId: number | null = null
    frameId = requestAnimationFrame(() => {
      frameId = null
      document.addEventListener('pointerdown', handlePointerDown, true)
    })
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId)
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [editingProp, setEditingProp])

  // ── Position + autoUpdate for the key-rename popup ─────────────────────
  useEffect(() => {
    if (!editingKey) return
    const anchor = keyAnchorRef.current
    const popup = keyPopupRef.current
    if (!anchor || !popup) {
      logger.warn('BlockPropertyEditor', 'key popup mounted without refs', {
        hasAnchor: anchor !== null,
        hasPopup: popup !== null,
        oldKey: editingKey.oldKey,
      })
      return
    }

    const update = () => {
      if (!anchor.isConnected || !popup.isConnected) {
        logger.warn('BlockPropertyEditor', 'anchor unmounted while key popup open', {
          oldKey: editingKey.oldKey,
          anchorConnected: anchor.isConnected,
          popupConnected: popup.isConnected,
        })
        return
      }
      computePosition(anchor, popup, {
        placement: 'bottom-start',
        middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
      })
        .then(({ x, y }) => {
          applySafePosition(popup, { x, y })
        })
        .catch((err: unknown) => {
          logger.warn(
            'BlockPropertyEditor',
            'key popup computePosition failed',
            { oldKey: editingKey.oldKey },
            err,
          )
          // Push popup off-screen on failure so it doesn't
          // float orphaned mid-page after the anchor scrolls or moves.
          applySafePosition(popup, null)
        })
    }

    return autoUpdate(anchor, popup, update)
  }, [editingKey])

  // ── Outside-click for the key-rename popup ─────────────────────────────
  useEffect(() => {
    if (!editingKey) return

    const handlePointerDown = (e: PointerEvent) => {
      const popup = keyPopupRef.current
      const anchor = keyAnchorRef.current
      if (!popup) return
      const target = e.target as Node | null
      if (!target) return
      if (popup.contains(target)) return
      if (anchor?.contains(target)) return
      setEditingKey(null)
    }

    let frameId: number | null = null
    frameId = requestAnimationFrame(() => {
      frameId = null
      document.addEventListener('pointerdown', handlePointerDown, true)
    })

    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId)
      document.removeEventListener('pointerdown', handlePointerDown, true)
    }
  }, [editingKey, setEditingKey])

  const propPopup = editingProp ? (
    <div
      ref={propPopupRef}
      data-editor-portal=""
      className="rounded-md border bg-popover p-1 shadow-(--shadow-floating) max-w-[calc(100vw-2rem)]"
      style={{ position: 'fixed', left: HIDDEN_LEFT, top: HIDDEN_TOP, zIndex: 50 }}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- fixed-position custom popover; native <dialog> brings top-layer/modal semantics and ::backdrop that conflict with this manually-positioned non-modal popup
      role="dialog"
      aria-label={t('block.editProperty')}
    >
      {selectOptions ? (
        // Listbox semantics so screen-reader / keyboard users
        // see a navigable list rather than a stack of generic buttons.
        // Mirrors the in-repo pattern in `TagValuePicker.tsx:172–199`.
        (() => {
          const selectedIdx = selectOptions.indexOf(editingProp.value)
          const optionId = (i: number) => `${selectListboxId}-option-${i}`
          return (
            <div
              ref={selectListRef}
              className="flex flex-col gap-0.5"
              data-testid="select-options-dropdown"
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- custom ARIA listbox of styled <button> options with aria-activedescendant nav; <select>/<datalist> can't render this or support async setProperty handlers
              role="listbox"
              aria-label={t('block.editProperty')}
              // #976 (item 10) — track the KEYBOARD-active row, not just the
              // currently-stored value, so arrow navigation moves the AT focus
              // ring. Falls back to the selected option when no key nav yet.
              aria-activedescendant={
                activeIndex >= 0
                  ? optionId(activeIndex)
                  : selectedIdx >= 0
                    ? optionId(selectedIdx)
                    : undefined
              }
              tabIndex={0}
              // #976 (item 10) — Arrow/Home/End/Enter listbox navigation. Held on
              // the listbox container (it owns `tabIndex={0}` + focus) rather than
              // per-option, mirroring `TagValuePicker.tsx`. Escape is handled at
              // the document level (see the value-popup effect above).
              onKeyDown={handleSelectListboxKeyDown}
            >
              {selectOptions.map((opt, i) => (
                <button
                  key={opt}
                  id={optionId(i)}
                  type="button"
                  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- option in a custom ARIA listbox; this is a <button> click target, native <option> can't host the handler or focus styling
                  role="option"
                  aria-selected={i === selectedIdx}
                  className={cn(
                    // #976 (item 11) — `focus-ring-visible` gives keyboard users a
                    // visible focus indicator while navigating the listbox (the
                    // bg-accent below marks the STORED value, not the nav cursor).
                    'text-left rounded px-2 py-1 text-sm hover:bg-accent transition-colors focus-ring-visible',
                    i === selectedIdx && 'bg-accent font-medium',
                    // The keyboard-active row gets the accent bg too so the nav
                    // cursor is visible even before the option is committed.
                    i === activeIndex && 'bg-accent',
                  )}
                  onClick={() => void commitSelectOption(opt)}
                >
                  {opt}
                </button>
              ))}
            </div>
          )
        })()
      ) : isRefProp ? (
        <fieldset
          className="flex flex-col gap-0.5 w-56 border-none p-0 m-0"
          data-testid="ref-picker"
          aria-label={t('block.refPickerLabel')}
        >
          <input
            ref={(el) => {
              el?.focus()
            }}
            type="text"
            className="rounded border px-2 py-1 text-sm w-full"
            aria-label={t('block.searchPages')}
            placeholder={t('block.searchPages')}
            data-testid="ref-search-input"
            value={refSearch}
            onChange={(e) => setRefSearch(e.target.value)}
          />
          <ScrollArea className="max-h-48 flex flex-col gap-0.5">
            {(() => {
              // Unicode-aware fold.
              const filtered = refPages.filter((page) =>
                matchesSearchFolded(page.content || '', refSearch),
              )
              if (filtered.length === 0) {
                return (
                  <div
                    className="px-2 py-1 text-sm text-muted-foreground"
                    data-testid="ref-no-results"
                  >
                    {t('block.noPagesFound')}
                  </div>
                )
              }
              return filtered.map((page) => (
                <button
                  key={page.id}
                  type="button"
                  className={cn(
                    // #976 (item 11) — visible keyboard focus ring on the
                    // ref-picker option buttons, matching the select-options
                    // listbox and the shared app-wide pattern.
                    'text-left rounded px-2 py-1 text-sm hover:bg-accent transition-colors truncate focus-ring-visible',
                    page.id === editingProp.value && 'bg-accent font-medium',
                  )}
                  onClick={async () => {
                    try {
                      unwrap(
                        await commands.setProperty(blockId, editingProp.key, {
                          value_text: null,
                          value_num: null,
                          value_date: null,
                          value_ref: page.id,
                          value_bool: null,
                        }),
                      )
                    } catch (err) {
                      reportIpcError('BlockPropertyEditor', 'property.saveFailed', err, t, {
                        blockId,
                        key: editingProp.key,
                        refPageId: page.id,
                      })
                    }
                    setEditingProp(null)
                  }}
                >
                  {page.content || t('block.untitled')}
                </button>
              ))
            })()}
          </ScrollArea>
        </fieldset>
      ) : (
        <input
          ref={(el) => {
            el?.focus()
          }}
          type="text"
          className="rounded border px-2 py-1 text-sm w-32"
          aria-label={t('block.editProperty')}
          defaultValue={editingProp.value}
          onBlur={async (e) => {
            const newValue = e.target.value.trim()
            if (newValue !== editingProp.value) {
              // #4010 (clear half) — an emptied chip means "remove this
              // value", and for a user-defined key that is only expressible
              // as a delete. `buildPropertyParams` would send `value_text:
              // ''` (rejected by `set_property.value_text.empty`) or an
              // all-null payload (rejected by the exactly-one-value rule for
              // non-reserved keys), so clearing could never succeed — the
              // user got `property.saveFailed` whatever they typed. No type is
              // needed to clear, so this runs before the definition is
              // resolved.
              //
              // `NON_DELETABLE_PROPERTIES` (= `is_builtin_property_key`) keeps
              // its two halves on the pre-existing `set_property` path below.
              // For the four RESERVED keys the all-null payload IS the clear
              // (`validate_set_property` accepts count==0 only for them),
              // though they are filtered out of the chip row upstream by
              // `useExtraBlockProperties` and do not reach here in practice.
              // For the LIFECYCLE keys (`created_at` / `completed_at` /
              // `repeat-*`) neither route works — `delete_property` refuses
              // them by name and the all-null write is rejected as
              // non-reserved — so they keep failing exactly as before rather
              // than gaining a new, equally-rejected code path.
              if (newValue === '' && !NON_DELETABLE_PROPERTIES.has(editingProp.key)) {
                try {
                  unwrap(await commands.deleteProperty(blockId, editingProp.key))
                } catch (err) {
                  reportIpcError('BlockPropertyEditor', 'property.saveFailed', err, t, {
                    blockId,
                    key: editingProp.key,
                  })
                }
                setEditingProp(null)
                return
              }
              // #4009 — the definition for THIS key may not have resolved
              // yet (`valueType === null`). The chip autofocuses and is meant
              // to be typed into straight away, so the user routinely
              // finishes before the per-key lookup lands. #3275 refused to
              // commit in that window for a good reason — the only type in
              // hand belonged to a DIFFERENT key, and writing against it
              // routes a date string through `Number(...)` into `value_num`
              // — but it also threw the freshly typed text away. Resolving
              // the definition for `editingProp.key` right here removes the
              // wrong-key hazard entirely, so a late definition costs a
              // moment instead of the user's input.
              let resolvedValueType = valueType
              if (resolvedValueType === null) {
                try {
                  const def = unwrap(await commands.getPropertyDef(editingProp.key))
                  // A MISS is a real answer ('text'), matching
                  // `usePropertyDefForEdit` and `BlockPropertyDrawer.getType`.
                  resolvedValueType = def?.value_type ?? 'text'
                } catch (err) {
                  // The lookup itself failed, so there is still no type for
                  // this key — and #3275's rule stands: never write against a
                  // guess. This is now the ONLY path that discards the edit,
                  // and it takes a real IPC failure to reach.
                  logger.warn('BlockPropertyEditor', 'commit skipped: value type unresolved', {
                    blockId,
                    key: editingProp.key,
                  })
                  reportIpcError('BlockPropertyEditor', 'property.saveFailed', err, t, {
                    blockId,
                    key: editingProp.key,
                  })
                  setEditingProp(null)
                  return
                }
              }
              // #4008 review note 4 — the inline chip renders a PLAIN TEXT
              // input for every non-select/non-ref type, so a `boolean`
              // property reaches `buildPropertyParams` as free text. Its
              // boolean branch is written for the drawer's checkbox, which
              // only ever supplies 'true' / 'false' / '': anything else maps
              // to `value_bool: false`, silently discarding what the user
              // typed AND overwriting the stored value. Refuse instead —
              // exactly what the number branch already does for unparseable
              // input, and the reason `date` (which stores the typed string
              // verbatim, destroying nothing) is deliberately left alone.
              if (resolvedValueType === 'boolean' && !['', 'true', 'false'].includes(newValue)) {
                notify.error(t('property.invalidBoolean'))
                setEditingProp(null)
                return
              }
              // #3275 — route through the SAME `buildPropertyParams` the
              // drawer path uses (`property-save-utils.ts` →
              // `handleSaveProperty`) instead of hard-coding
              // `value_text`/nulling every other typed column. This is what
              // keeps a user-defined `number`/`date` property's typed
              // column intact when edited from the inline chip, and
              // surfaces the same `property.invalidNumber` toast the
              // drawer shows for an unparseable number.
              const result = buildPropertyParams(
                blockId,
                editingProp.key,
                newValue,
                resolvedValueType,
              )
              if (!result.ok) {
                notify.error(t('property.invalidNumber'))
              } else {
                try {
                  unwrap(
                    await commands.setProperty(result.params.blockId, result.params.key, {
                      value_text: result.params.valueText ?? null,
                      value_num: result.params.valueNum ?? null,
                      value_date: result.params.valueDate ?? null,
                      value_ref: result.params.valueRef ?? null,
                      value_bool: result.params.valueBool ?? null,
                    }),
                  )
                } catch (err) {
                  reportIpcError('BlockPropertyEditor', 'property.saveFailed', err, t, {
                    blockId,
                    key: editingProp.key,
                  })
                }
              }
            }
            setEditingProp(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') setEditingProp(null)
          }}
        />
      )}
    </div>
  ) : null

  const keyPopup = editingKey ? (
    <div
      ref={keyPopupRef}
      data-editor-portal=""
      className="property-key-editor rounded-md border bg-popover p-1 shadow-(--shadow-floating)"
      style={{ position: 'fixed', left: HIDDEN_LEFT, top: HIDDEN_TOP, zIndex: 50 }}
    >
      <input
        ref={(el) => {
          el?.focus()
        }}
        type="text"
        className="rounded border px-2 py-1 text-sm w-32"
        aria-label={t('block.editProperty')}
        defaultValue={editingKey.oldKey}
        onBlur={async (e) => {
          const newKey = e.target.value.trim()
          if (newKey && newKey !== editingKey.oldKey) {
            try {
              // #3275 — read the OLD key's raw typed row instead of
              // re-writing `editingKey.value` (the already-flattened
              // display string from `useExtraBlockProperties`'s `mapRows`,
              // which collapses value_text/value_date/value_num into one
              // string and cannot tell them apart). Re-flattening it back
              // into `value_text` on rename is exactly what nulled
              // `value_num`/`value_date` for a renamed number/date property.
              const rows: PropertyRow[] = unwrap(await commands.getProperties(blockId))
              const oldRow = rows.find((r) => r.key === editingKey.oldKey)
              if (!oldRow) {
                // #3275 (review finding 2) — no row for the old key (empty or
                // stale result, a concurrent delete, a key mismatch). Every
                // `oldRow?.value_X ?? null` below would collapse to null and
                // write an ALL-NULL row under the new key, destroying the
                // value. There is nothing safe to carry over — the flattened
                // `editingKey.value` cannot tell value_text from value_date —
                // so abort with the same `renameFailed` toast the IPC-failure
                // path uses and leave the original key exactly as it is.
                throw new Error(
                  `rename aborted: no property row for key "${editingKey.oldKey}" on block ${blockId}`,
                )
              }
              // #4010 — carry the property DEFINITION to the new key as well.
              // `set_property` never inserts a `property_definitions` row, so
              // without this the renamed key is undeclared: the next chip
              // edit's `getPropertyDef` misses, `valueType` falls back to
              // `'text'`, and the `value_num`/`value_date` the block below
              // carefully carries over is re-flattened into `value_text` —
              // the exact bug #3275 fixed, reappearing one edit later.
              //
              // Deliberately BEST-EFFORT and ahead of the value write:
              // ahead, because the engine validates the payload shape against
              // the declaration; best-effort, because the value carry is the
              // part that must not be lost, and it worked before definitions
              // were carried at all. `create_property_def` is INSERT OR
              // IGNORE, so renaming onto an already-declared key is a no-op.
              try {
                const carried = COLUMN_BACKED_PROPERTY_KEYS.has(newKey)
                  ? // A column-backed target (`due_date` & co., `space`) is not a
                    // `block_properties` row at all, and `create_property_def`
                    // has no reserved-key guard of its own: declaring one would
                    // persist a bogus type for a key whose shape is fixed by the
                    // `blocks` column (and mis-render it in the drawer /
                    // Properties tab). The value write below rejects such a
                    // rename anyway — a FAILED rename must not leave a
                    // declaration behind.
                    null
                  : carriedRenameDefinition(
                      unwrap(await commands.getPropertyDef(editingKey.oldKey)),
                      oldRow,
                    )
                if (carried) {
                  unwrap(
                    await commands.createPropertyDef(newKey, carried.valueType, carried.options),
                  )
                }
              } catch (err) {
                logger.warn(
                  'BlockPropertyEditor',
                  'could not carry property definition to renamed key',
                  { blockId, oldKey: editingKey.oldKey, newKey },
                  err,
                )
              }
              unwrap(
                await commands.setProperty(blockId, newKey, {
                  // Non-optional access on purpose: `oldRow` is guaranteed
                  // present by the guard above, and `?.` here is what let the
                  // all-null write through in the first place.
                  value_text: oldRow.value_text ?? null,
                  value_num: oldRow.value_num ?? null,
                  value_date: oldRow.value_date ?? null,
                  value_ref: oldRow.value_ref ?? null,
                  value_bool: oldRow.value_bool != null ? oldRow.value_bool !== 0 : null,
                }),
              )
              // Remove the OLD key, now that the new one holds the value.
              //
              // This used to be an all-null `set_property`, which
              // `validate_set_property` accepts for the four RESERVED keys
              // only ("Reserved keys allow all-null values (= clear the
              // column)"); for any ordinary user key it is rejected with
              // "SetProperty must have exactly 1 non-null value field, found
              // 0". So `unwrap` threw and every rename of a user-defined
              // property — the ordinary case — ended in `property.renameFailed`
              // with the old chip still on the block, even though the new key
              // had already been written. Same defect as the emptied-chip clear
              // above, one branch over, and invisible here for as long as the
              // test fixture answered `{status:'ok'}` to every payload.
              //
              // The split matches that clear exactly: `delete_property` is the
              // removal a user key supports, and the system-managed keys keep
              // the all-null payload (right for the reserved four, and no worse
              // than before for the lifecycle keys, which neither route
              // accepts).
              if (NON_DELETABLE_PROPERTIES.has(editingKey.oldKey)) {
                unwrap(
                  await commands.setProperty(blockId, editingKey.oldKey, {
                    value_text: null,
                    value_num: null,
                    value_date: null,
                    value_ref: null,
                    value_bool: null,
                  }),
                )
              } else {
                unwrap(await commands.deleteProperty(blockId, editingKey.oldKey))
              }
            } catch (err) {
              reportIpcError('BlockPropertyEditor', 'property.renameFailed', err, t, {
                blockId,
                oldKey: editingKey.oldKey,
              })
            }
          }
          setEditingKey(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') setEditingKey(null)
        }}
      />
    </div>
  ) : null

  return (
    <>
      {editingProp && (
        <span
          ref={propAnchorRef}
          aria-hidden="true"
          data-testid="block-property-editor-anchor"
          style={{ display: 'inline-block', width: 0, height: 0 }}
        />
      )}
      {editingKey && (
        <span
          ref={keyAnchorRef}
          aria-hidden="true"
          data-testid="block-property-key-editor-anchor"
          style={{ display: 'inline-block', width: 0, height: 0 }}
        />
      )}
      {propPopup && createPortal(propPopup, document.body)}
      {keyPopup && createPortal(keyPopup, document.body)}
    </>
  )
}
