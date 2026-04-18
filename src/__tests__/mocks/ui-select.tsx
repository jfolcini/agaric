// Shared mock for `@/components/ui/select` used by component tests that need
// Radix UI Select primitives to work in jsdom.
//
// Radix Select relies on layout APIs (getBoundingClientRect, pointer events)
// that jsdom does not implement, so tests cannot drive the real Radix Select.
// This mock renders the Select as a native `<select>` + `<option>` tree so
// that `userEvent.selectOptions()` and `fireEvent.change()` work, while
// preserving the component-contract props (`aria-label`, `id`, `className`,
// `size`, `disabled`, `data-testid`) that tests assert against.
//
// Usage: tests import from this mock via the global `vi.mock('@/components/ui/select', …)`
// declaration in `src/test-setup.ts`. Individual tests that need custom
// behavior can still declare their own per-file `vi.mock('@/components/ui/select', …)`
// which overrides the shared mock for that file.
//
// How it works:
//  - `<Select>` establishes a context holding `value`, `onValueChange`, `disabled`,
//    and a ref that captures the trigger's props at render time.
//  - `<SelectTrigger>` writes its props into that ref and renders nothing itself
//    (it is replaced by the native `<select>` produced by `<SelectContent>`).
//  - `<SelectContent>` reads the captured trigger props and renders a
//    `<select>` with those attributes forwarded. `size="sm"` is surfaced as
//    `data-size="sm"` so tests can assert on it without conflicting with the
//    native `<select size>` attribute (which means "visible row count").
//  - `<SelectItem value="…">` renders a native `<option>`.
import type React from 'react'
import { createContext, createElement, useContext, useRef } from 'react'

type TriggerProps = Record<string, unknown>

type SelectCtx = {
  value?: string
  onValueChange?: (v: string) => void
  disabled?: boolean
  triggerPropsRef: { current: TriggerProps }
}

const Ctx = createContext<SelectCtx>({
  triggerPropsRef: { current: {} },
})

type SelectProps = {
  value?: string
  onValueChange?: (v: string) => void
  disabled?: boolean
  children?: React.ReactNode
}

export function Select({ value, onValueChange, disabled, children }: SelectProps) {
  const triggerPropsRef = useRef<TriggerProps>({})
  const ctx: SelectCtx = { triggerPropsRef }
  if (value !== undefined) ctx.value = value
  if (onValueChange !== undefined) ctx.onValueChange = onValueChange
  if (disabled !== undefined) ctx.disabled = disabled
  return createElement(Ctx.Provider, { value: ctx }, children)
}

type SelectTriggerProps = {
  size?: 'default' | 'sm'
  className?: string
  children?: React.ReactNode
  [key: string]: unknown
}

export function SelectTrigger({ children: _children, ...props }: SelectTriggerProps) {
  const ctx = useContext(Ctx)
  // Capture the latest trigger props so SelectContent can forward them
  // onto the native <select>. The trigger itself renders nothing — the
  // rendered element lives inside SelectContent.
  ctx.triggerPropsRef.current = { ...props }
  return null
}

type SelectValueProps = {
  placeholder?: string
  children?: React.ReactNode
}

export function SelectValue(_props: SelectValueProps) {
  return null
}

type SelectContentProps = {
  children?: React.ReactNode
}

export function SelectContent({ children }: SelectContentProps) {
  const ctx = useContext(Ctx)
  const { size, ...rest } = ctx.triggerPropsRef.current as {
    size?: string
    [key: string]: unknown
  }
  const attrs: Record<string, unknown> = {
    ...rest,
    value: ctx.value ?? '',
    onChange: (e: React.ChangeEvent<HTMLSelectElement>) => ctx.onValueChange?.(e.target.value),
  }
  if (ctx.disabled !== undefined) attrs['disabled'] = ctx.disabled
  if (size !== undefined) attrs['data-size'] = size
  return createElement('select', attrs, children)
}

type SelectItemProps = {
  value: string
  children?: React.ReactNode
  disabled?: boolean
}

export function SelectItem({ value, children, disabled }: SelectItemProps) {
  const attrs: Record<string, unknown> = { value }
  if (disabled !== undefined) attrs['disabled'] = disabled
  return createElement('option', attrs, children)
}

type GroupLikeProps = {
  children?: React.ReactNode
  [key: string]: unknown
}

export function SelectGroup({ children }: GroupLikeProps) {
  return createElement('optgroup', {}, children)
}

export function SelectLabel({ children }: GroupLikeProps) {
  return createElement('span', {}, children)
}

export function SelectSeparator(_props: GroupLikeProps) {
  return null
}

export function SelectScrollUpButton(_props: GroupLikeProps) {
  return null
}

export function SelectScrollDownButton(_props: GroupLikeProps) {
  return null
}
