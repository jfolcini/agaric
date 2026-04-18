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
 *  - Clearing dispatches a synthetic onChange with `target.value = ''`
 *    so callers that read `e.target.value` keep working unchanged.
 */

import { X } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Input } from './input'

export interface SearchInputProps extends Omit<React.ComponentProps<'input'>, 'onChange'> {
  /** Current value (controlled). The clear button is only rendered when non-empty. */
  value: string
  /** Change handler — called with a synthetic event whose `target.value` is `""` when cleared. */
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  /** Optional translation key override for the clear button's aria-label. Defaults to `action.clear`. */
  clearAriaLabelKey?: string
  /** Extra className for the outer wrapper (positioning / width). Use `className` for the input itself. */
  wrapperClassName?: string
}

const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
  (
    { value, onChange, className, wrapperClassName, clearAriaLabelKey = 'action.clear', ...props },
    ref,
  ) => {
    const { t } = useTranslation()
    const inputRef = React.useRef<HTMLInputElement | null>(null)
    // Forward the ref to the input element so callers can still focus it.
    const setInputRef = React.useCallback(
      (node: HTMLInputElement | null) => {
        inputRef.current = node
        if (typeof ref === 'function') ref(node)
        else if (ref != null)
          (ref as React.MutableRefObject<HTMLInputElement | null>).current = node
      },
      [ref],
    )

    const hasValue = value !== ''

    const handleClear = React.useCallback(() => {
      const input = inputRef.current
      if (!input) return
      // Use the native setter so React detects the value change.
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set
      setter?.call(input, '')
      const event = new Event('input', { bubbles: true })
      input.dispatchEvent(event)
      // React will call onChange via the synthetic handler; also fire an
      // explicit call so controlled callers that bypass the dispatched
      // event (e.g. tests with a stubbed input) still see the clear.
      onChange({
        target: input,
        currentTarget: input,
      } as unknown as React.ChangeEvent<HTMLInputElement>)
      input.focus()
    }, [onChange])

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
              'focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50',
              'h-7 w-7 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11',
            )}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
    )
  },
)
SearchInput.displayName = 'SearchInput'

export { SearchInput }
