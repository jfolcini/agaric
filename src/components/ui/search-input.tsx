/**
 * SearchInput — Input wrapper that renders a clear (✕) button when the
 * field has content (UX-221). Replaces the bare `Input` primitive for
 * filter / search use cases across the app (SearchPanel, TagFilterPanel,
 * TrashView, BacklinkFilterBuilder, PageBrowser).
 *
 * Design decisions:
 *  - Composes the existing `Input` primitive rather than duplicating
 *    its styles (single source of truth for height / border / focus).
 *  - Clear button uses `type="button"` so it never submits a parent
 *    form, `aria-label` via `t()` for i18n, and a 44px minimum touch
 *    target on coarse pointers per AGENTS.md mandatory patterns.
 *  - Clearing emits a real native `input` event on the `<input>` (via
 *    the React-aware native value setter) so `onChange` callers see
 *    `e.target.value === ''` without any synthetic-event sleight of
 *    hand. MAINT-207 (e): callers that need an explicit clear signal
 *    can opt into `onClear` (preferred — no synthetic event, no
 *    dependency on the change pipeline). The previous synthetic
 *    `onChange({ target, currentTarget })` fallback was removed
 *    because consumers reading `e.bubbles` / `e.preventDefault` would
 *    have hit `undefined` / a no-op; the native dispatch covers every
 *    legitimate `onChange` reader.
 */

import { X } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

import { Input } from './input'

export interface SearchInputProps extends Omit<React.ComponentProps<'input'>, 'onChange'> {
  /** Current value (controlled). The clear button is only rendered when non-empty. */
  value: string
  /**
   * Change handler. On clear, called with a real React change event
   * whose `target.value === ''` (dispatched via the native value setter
   * so the React change pipeline picks it up normally — no synthetic
   * event surface).
   */
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  /**
   * MAINT-207 (e): optional explicit clear signal. Preferred over
   * reading `e.target.value === ''` inside `onChange` — fires exactly
   * once per clear-button click, doesn't depend on the change pipeline,
   * and is safe to call alongside `onChange`. Both fire on clear when
   * supplied; callers that need only one can ignore the other.
   */
  onClear?: () => void
  /** Optional translation key override for the clear button's aria-label. Defaults to `action.clear`. */
  clearAriaLabelKey?: string
  /** Extra className for the outer wrapper (positioning / width). Use `className` for the input itself. */
  wrapperClassName?: string
  ref?: React.Ref<HTMLInputElement>
}

const SearchInput = ({
  ref,
  value,
  onChange,
  onClear,
  className,
  wrapperClassName,
  clearAriaLabelKey = 'action.clear',
  ...props
}: SearchInputProps) => {
  const { t } = useTranslation()
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  // Forward the ref to the input element so callers can still focus it.
  const setInputRef = React.useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node
      if (typeof ref === 'function') ref(node)
      else if (ref != null) (ref as React.RefObject<HTMLInputElement | null>).current = node
    },
    [ref],
  )

  const hasValue = value !== ''

  const handleClear = React.useCallback(() => {
    const input = inputRef.current
    if (!input) return
    // Use the native setter so React detects the value change, then
    // dispatch a real `input` event. This is the React-recommended
    // pattern for programmatic input value changes (see facebook/react
    // #11488); the resulting React.ChangeEvent reaches `onChange` via
    // the normal pipeline.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    onClear?.()
    input.focus()
  }, [onClear])

  return (
    <div className={cn('relative', wrapperClassName)} data-slot="search-input">
      <Input
        ref={setInputRef}
        type={props.type ?? 'text'}
        value={value}
        onChange={onChange}
        className={cn(hasValue && 'pr-10 [@media(pointer:coarse)]:pr-12', className)}
        {...props}
      />
      {hasValue && (
        <button
          type="button"
          aria-label={t(clearAriaLabelKey)}
          onClick={handleClear}
          data-testid="search-input-clear"
          className={cn(
            'absolute top-1/2 right-1 -translate-y-1/2 inline-flex items-center justify-center rounded-sm text-muted-foreground transition-colors',
            'hover:text-foreground hover:bg-accent/50',
            'focus-ring-visible',
            'h-7 w-7 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11',
          )}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
SearchInput.displayName = 'SearchInput'

export { SearchInput }
