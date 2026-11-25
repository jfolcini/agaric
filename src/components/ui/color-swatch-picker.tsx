/**
 * ColorSwatchPicker — a row of colour swatches, a "no colour" swatch, and a
 * custom colour behind a disclosure.
 *
 * The swatches are a Radix ToggleGroup, `type="single"`: a `radiogroup` of
 * `radio`s with roving focus. An arrow key moves focus only; Enter, Space or
 * a click picks. Unlike the segmented `ToggleGroup` in `toggle-group.tsx`, a
 * pick here commits a colour, so checking each swatch the arrows pass would
 * write every one of them.
 *
 * The picked swatch carries a `border-foreground` ring around a gap of the
 * popover's colour, inside the swatch's own box. A check mark would need a
 * colour that reads on every swatch in every theme, and the accents span
 * light amber to dark slate.
 *
 * The custom colour is react-colorful's `HexColorPicker` (restyled in
 * `index.css`) and a hex field. The picker commits when a drag or an arrow key
 * ends (`onChangeEnd`), not on every frame; the field commits on Enter, or on
 * blur once edited.
 */

import { Ban } from 'lucide-react'
import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui'
import type * as React from 'react'
import { useId, useState } from 'react'
import { HexColorPicker } from 'react-colorful'

import { ChevronToggle } from '@/components/ui/chevron-toggle'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

// On a coarse pointer `touch-hit-area` gives a swatch its 44 px target; the
// swatch itself stays 28 px, so the row of swatches fits a 360 px phone.
const SWATCH_CLASSES =
  'inline-flex size-7 shrink-0 items-center justify-center rounded-full border-2 border-transparent p-0.5 transition-colors touch-hit-area focus-ring-visible'

/** Where the custom picker starts when the current colour is not a custom one. */
const DEFAULT_CUSTOM_COLOR = '#3b82f6'

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i

/** `#rgb` or `#rrggbb`, the `#` optional, as lowercase `#rrggbb`; null for anything else. */
function parseHex(text: string): string | null {
  const digits = HEX_RE.exec(text.trim())?.[1]
  if (digits === undefined) return null
  const full = digits.length === 3 ? digits.replace(/./g, '$&$&') : digits
  return `#${full.toLowerCase()}`
}

export interface ColorSwatch {
  /** What `onValueChange` reports. */
  value: string
  /** The swatch's accessible name. */
  label: string
  /** The CSS colour the swatch paints. */
  color: string
}

export interface ColorSwatchPickerProps {
  swatches: readonly ColorSwatch[]
  /** The current colour: a swatch's value, a custom `#rrggbb`, or unset. */
  value: string | undefined
  /** A swatch was picked. Not called for the swatch already picked. */
  onValueChange: (value: string) => void
  /** A custom colour was committed, as lowercase `#rrggbb`. */
  onCustomColor: (hex: string) => void
  /** The "no colour" swatch was pressed; it is disabled while `value` is unset. */
  onClear: () => void
  clearLabel: string
  customLabel: string
  hexLabel: string
  /** Shown under the hex field when it holds no hex colour. */
  hexError: string
  'aria-label': string
  className?: string
}

function ColorSwatchPicker({
  swatches,
  value,
  onValueChange,
  onCustomColor,
  onClear,
  clearLabel,
  customLabel,
  hexLabel,
  hexError,
  'aria-label': ariaLabel,
  className,
}: ColorSwatchPickerProps): React.ReactElement {
  const custom = value !== undefined && !swatches.some((s) => s.value === value) ? value : undefined
  const [customOpen, setCustomOpen] = useState(custom !== undefined)
  const customId = useId()
  return (
    <div data-slot="color-swatch-picker" className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center gap-1 [@media(pointer:coarse)]:gap-2">
        <ToggleGroupPrimitive.Root
          type="single"
          aria-label={ariaLabel}
          // A custom colour, or none, matches no swatch, so none is checked.
          value={value ?? ''}
          // Radix reports pressing the picked swatch again as `''`.
          onValueChange={(next) => {
            if (next !== '') onValueChange(next)
          }}
          className="flex items-center gap-1 [@media(pointer:coarse)]:gap-2"
        >
          {swatches.map((swatch) => (
            <ToggleGroupPrimitive.Item
              key={swatch.value}
              value={swatch.value}
              aria-label={swatch.label}
              className={cn(SWATCH_CLASSES, 'hover:border-border aria-checked:border-foreground')}
            >
              <span
                aria-hidden
                className="size-full rounded-full ring-1 ring-foreground/10 ring-inset"
                style={{ backgroundColor: swatch.color }}
              />
            </ToggleGroupPrimitive.Item>
          ))}
        </ToggleGroupPrimitive.Root>
        <Separator orientation="vertical" className="mx-0.5 data-[orientation=vertical]:h-5" />
        <button
          type="button"
          aria-label={clearLabel}
          disabled={value === undefined}
          onClick={onClear}
          className={cn(
            SWATCH_CLASSES,
            'text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50',
          )}
        >
          <Ban aria-hidden className="size-4" />
        </button>
      </div>
      <button
        type="button"
        aria-expanded={customOpen}
        aria-controls={customId}
        onClick={() => setCustomOpen((open) => !open)}
        className="flex items-center gap-1.5 self-start rounded-sm py-0.5 pr-1 text-xs text-muted-foreground transition-colors hover:text-foreground touch-hit-area focus-ring-visible"
      >
        <ChevronToggle isExpanded={customOpen} />
        {customLabel}
        {custom !== undefined && (
          <span
            aria-hidden
            className="size-3 rounded-full ring-1 ring-foreground/10 ring-inset"
            style={{ backgroundColor: custom }}
          />
        )}
      </button>
      {customOpen && (
        <CustomColor
          id={customId}
          value={custom}
          onCommit={onCustomColor}
          hexLabel={hexLabel}
          hexError={hexError}
        />
      )}
    </div>
  )
}
ColorSwatchPicker.displayName = 'ColorSwatchPicker'

function CustomColor({
  id,
  value,
  onCommit,
  hexLabel,
  hexError,
}: {
  id: string
  value: string | undefined
  onCommit: (hex: string) => void
  hexLabel: string
  hexError: string
}): React.ReactElement {
  const [draft, setDraft] = useState(() => parseHex(value ?? '') ?? DEFAULT_CUSTOM_COLOR)
  const [text, setText] = useState(draft)
  // Only an edit commits on blur: tabbing through the field leaves the colour alone.
  const [edited, setEdited] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const errorId = useId()

  const commitText = () => {
    const hex = parseHex(text)
    if (hex === null) {
      setInvalid(true)
      return
    }
    setText(hex)
    setDraft(hex)
    setEdited(false)
    if (hex !== value) onCommit(hex)
  }

  return (
    <div id={id} className="flex flex-col gap-2">
      <HexColorPicker
        color={draft}
        onChange={(hex) => {
          setDraft(hex)
          setText(hex)
          setInvalid(false)
        }}
        onChangeEnd={onCommit}
      />
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          data-testid="custom-color-preview"
          className="size-9 shrink-0 rounded-md border [@media(pointer:coarse)]:size-11"
          style={{ backgroundColor: draft }}
        />
        <Input
          value={text}
          aria-label={hexLabel}
          aria-invalid={invalid}
          aria-describedby={invalid ? errorId : undefined}
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
          onChange={(e) => {
            const next = e.target.value
            setText(next)
            setEdited(true)
            const hex = parseHex(next)
            if (hex !== null) {
              setDraft(hex)
              setInvalid(false)
            }
          }}
          onBlur={() => {
            if (edited) commitText()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitText()
            }
          }}
        />
      </div>
      {invalid && (
        <p id={errorId} className="text-xs text-destructive">
          {hexError}
        </p>
      )}
    </div>
  )
}

export { ColorSwatchPicker }
