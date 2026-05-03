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
//  - `<SelectItem value="…">` renders a native `<option>` plus, when an
//    `endContent` prop is present, the slot fragment portaled into
//    `document.body` so the test DOM has the chip available for
//    `data-testid` queries without nesting non-text content under
//    `<option>` (which jsdom warns against).
import type React from 'react'
import { createContext, createElement, Fragment, useContext, useRef } from 'react'
import { createPortal } from 'react-dom'

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

/**
 * Element types valid as direct children of a native `<select>` (mirroring
 * the HTML rule). Children whose React `type` is on this allowlist render
 * inline; anything else (e.g. a `<button>` "create another space" hint
 * passed inside `<SelectContent>` in production) is portaled to
 * `document.body` so the test DOM keeps it queryable without producing a
 * "<select> cannot contain a nested <button>" hydration warning.
 */
const SELECT_VALID_CHILD_TYPES = new Set<unknown>([
  SelectItem,
  SelectGroup,
  SelectLabel,
  // `SelectSeparator` and the scroll buttons render `null` in the mock, so
  // they are technically harmless inside `<select>`, but we list them here
  // to make the allowlist exhaustive against the public mock surface.
])

function flattenChildren(children: React.ReactNode): React.ReactNode[] {
  // Walk the children tree (arrays and Fragment-likes) and emit a flat list
  // of leaf nodes, dropping `null` / `undefined` / `false`. SpaceSwitcher
  // produces `[<SelectItem>...].map(...)` AS A SINGLE CHILD (nested array)
  // alongside scalar `<SelectSeparator />` siblings; the recursion lets the
  // partition function see each leaf independently.
  const out: React.ReactNode[] = []
  // biome-ignore lint/suspicious/noExplicitAny: dynamic React element traversal
  const walk = (node: any) => {
    if (node == null || node === false || node === '') return
    if (Array.isArray(node)) {
      for (const n of node) walk(n)
      return
    }
    out.push(node)
  }
  walk(children)
  return out
}

function partitionSelectChildren(children: React.ReactNode): {
  inside: React.ReactNode[]
  portaled: React.ReactNode[]
} {
  const inside: React.ReactNode[] = []
  const portaled: React.ReactNode[] = []
  for (const child of flattenChildren(children)) {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic React element introspection
    const type = (child as any)?.type
    if (
      type === undefined ||
      // Plain text / number nodes (no `type` property in React's view).
      // Intrinsic HTML element strings: only the few that HTML's <select>
      // model accepts as direct children. Crucially, 'button' / 'div' /
      // arbitrary other intrinsic strings are NOT on this list — they
      // match the production "<button> hint inside <SelectContent>"
      // pattern (UX-373) that triggers the very warning this mock exists
      // to avoid.
      type === 'option' ||
      type === 'optgroup' ||
      type === 'hr' ||
      SELECT_VALID_CHILD_TYPES.has(type) ||
      // SelectSeparator + scroll buttons render `null`; let them through to keep the partition exhaustive.
      type === SelectSeparator ||
      type === SelectScrollUpButton ||
      type === SelectScrollDownButton
    ) {
      inside.push(child)
    } else {
      portaled.push(child)
    }
  }
  return { inside, portaled }
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
  const { inside, portaled } = partitionSelectChildren(children)
  const selectEl = createElement('select', attrs, inside)
  if (portaled.length === 0) return selectEl
  return createElement(
    Fragment,
    null,
    selectEl,
    createPortal(createElement(Fragment, null, portaled), document.body),
  )
}

type SelectItemProps = {
  value: string
  children?: React.ReactNode
  disabled?: boolean
  /**
   * Mirror of the real `SelectItem`'s `endContent` slot — content rendered
   * AFTER `<SelectPrimitive.ItemText>`, outside the auto-mirror surface.
   * In jsdom the native `<select>` tree forbids non-text children inside
   * `<option>`, so we portal the slot into a hidden sibling of the
   * `<select>` (set up by `SelectContent`) so the chip lives in the
   * document tree and is queryable via `document.querySelectorAll`
   * without polluting the option text.
   */
  endContent?: React.ReactNode
}

export function SelectItem({ value, children, disabled, endContent }: SelectItemProps) {
  const attrs: Record<string, unknown> = { value }
  if (disabled !== undefined) attrs['disabled'] = disabled
  const optionEl = createElement('option', attrs, children)
  if (endContent === undefined || endContent === null) return optionEl
  // Fragment + portal-to-`document.body` so the `<option>` stays a
  // direct child of the host `<select>` (HTML rule) while the chip
  // mounts elsewhere in the document — queryable from tests via
  // document-scoped `data-testid` selectors but never nested under
  // `<option>` (which would trigger a jsdom ancestor warning).
  return createElement(Fragment, null, optionEl, createPortal(endContent, document.body))
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
