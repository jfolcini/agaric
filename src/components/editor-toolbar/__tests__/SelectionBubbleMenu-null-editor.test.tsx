/**
 * Null-editor safety tests for `SelectionBubbleMenu`.
 *
 * Two separate mount/teardown-race gaps, two separate rigs:
 *
 * 1. #3056 — the `useEditorState` selector's `ctx.editor` can be null even
 *    though the `editor` prop is typed non-null. Covered by the
 *    `#3056` describe block below, which mocks `@tiptap/react`'s
 *    `useEditorState` to invoke the component's REAL (unmodified) selector
 *    with `ctx.editor: null` — exactly mirroring what TipTap's internal
 *    `EditorStateManager` snapshot looks like during the race — while the
 *    component still receives a normal, non-null `editor` object for
 *    everything else it touches at render time. This isolates the exact
 *    code path #3056 changed. (A literal `null` `editor` prop would instead
 *    trip the #3061 gap below, not this one — hence the `{}` stub.)
 *
 * 2. #3061 — the raw `editor` prop itself (not just `ctx.editor` from the
 *    selector) can be transiently null during the same race. The mount
 *    effect that wires up the `open-link-popover` listener used to
 *    dereference it directly (`editor.view?.dom`), throwing
 *    "Cannot read properties of null (reading 'view')". Covered by the
 *    `#3061` describe block below, which renders with a literal `null`
 *    `editor` prop (the `useEditorState`/`BubbleMenu` mocks above still
 *    apply, so this isolates the raw-dereference fix from the #3056 one).
 *
 * 3. #3061 (anchor) — `virtualAnchorRef.current.getBoundingClientRect`
 *    (handed to Radix's `PopoverAnchor virtualRef`) also dereferenced
 *    `editor.state`/`editor.view` directly, with no guard. Radix invokes
 *    that closure repeatedly for as long as the link popover stays open
 *    (layout/scroll/resize recalcs), not just once at click time, so it can
 *    run after `editor` has gone null mid-race. `@/components/ui/popover`'s
 *    `PopoverAnchor` is mocked below to capture the `virtualRef` so the
 *    closure can be invoked directly, independent of whether the popover is
 *    actually open — isolating this from the #3056/#3061-dom gaps above.
 */

import { render, screen } from '@testing-library/react'
import type React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { SelectionBubbleMenu } from '@/components/editor-toolbar/SelectionBubbleMenu'
import { t } from '@/lib/i18n'

// Force the selector to observe `ctx.editor: null` — the exact snapshot
// shape `useEditorState`'s internal `EditorStateManager` can hand a selector
// mid mount/teardown (see useEditorState.ts's `getSnapshot`/`watch`).
vi.mock('@tiptap/react', async () => {
  const actual = await vi.importActual<typeof import('@tiptap/react')>('@tiptap/react')
  return {
    ...actual,
    useEditorState: <T,>(opts: {
      selector: (ctx: { editor: null; transactionNumber: number }) => T
    }): T => opts.selector({ editor: null, transactionNumber: 0 }),
  }
})

// BubbleMenu is a TipTap floating-UI plugin view bound to a real ProseMirror
// `EditorView` — irrelevant to the null-selector guard under test. Always
// render children, matching `SelectionBubbleMenu.test.tsx`'s existing stub.
vi.mock('@tiptap/react/menus', () => ({
  BubbleMenu: ({
    children,
    role,
    'aria-label': ariaLabel,
    'aria-controls': ariaControls,
    className,
    'data-testid': dataTestId,
  }: {
    children: React.ReactNode
    role?: string
    'aria-label'?: string
    'aria-controls'?: string
    className?: string
    'data-testid'?: string
  }) => (
    <div
      role={role}
      aria-label={ariaLabel}
      aria-controls={ariaControls}
      className={className}
      data-testid={dataTestId}
    >
      {children}
    </div>
  ),
}))

vi.mock('@/components/ui/separator', () => ({
  Separator: ({ orientation, className }: { orientation?: string; className?: string }) => (
    <div data-testid="separator" data-orientation={orientation} className={className} />
  ),
}))

// Capture the `virtualRef` handed to `PopoverAnchor` (which SelectionBubbleMenu
// wires to `virtualAnchorRef`) so the #3061-anchor test can invoke its
// `getBoundingClientRect` closure directly, independent of Radix's own
// open/positioning lifecycle. Everything else re-exports the real module.
let capturedVirtualRef: { current: { getBoundingClientRect: () => DOMRect } } | null = null

vi.mock('@/components/ui/popover', async () => {
  const actual =
    await vi.importActual<typeof import('@/components/ui/popover')>('@/components/ui/popover')
  return {
    ...actual,
    PopoverAnchor: ({
      virtualRef,
    }: {
      virtualRef: { current: { getBoundingClientRect: () => DOMRect } }
    }) => {
      capturedVirtualRef = virtualRef
      return null
    },
  }
})

// Minimal stub — none of its members are touched at render time once the
// mocked selector reports `state.link: false` (the link edit path, the only
// render-time reader of `editor.state`/`editor.getAttributes`, is gated on
// `state.link`). `view` stays `undefined` deliberately: the mount effect
// reads it via `editor.view?.dom`, which is exactly the line this rig exists
// to route around while still proving the SELECTOR guard.
function makeStubEditor(): React.ComponentProps<typeof SelectionBubbleMenu>['editor'] {
  return {} as unknown as React.ComponentProps<typeof SelectionBubbleMenu>['editor']
}

describe('#3056 — SelectionBubbleMenu null-editor safety', () => {
  it('renders without throwing when the useEditorState snapshot carries a null editor', () => {
    expect(() => {
      render(<SelectionBubbleMenu editor={makeStubEditor()} />)
    }).not.toThrow()
  })

  it('falls back to safe defaults: no active marks, Link not pressed', () => {
    render(<SelectionBubbleMenu editor={makeStubEditor()} />)
    for (const key of [
      'toolbar.bold',
      'toolbar.italic',
      'toolbar.code',
      'toolbar.highlight',
      'toolbar.underline',
    ]) {
      expect(screen.getByRole('button', { name: t(key) })).toHaveAttribute('aria-pressed', 'false')
    }
    // #2995's disabledWhenFalse guard reads `canStrike`, which the null
    // branch defaults to `false`.
    expect(screen.getByRole('button', { name: t('toolbar.strikethrough') })).toBeDisabled()
    expect(screen.getByRole('button', { name: t('toolbar.link') })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('passes axe audit with a null-editor snapshot', async () => {
    const { container } = render(<SelectionBubbleMenu editor={makeStubEditor()} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})

// #3061 — a literal `null` `editor` prop, exercising the raw
// `editor.view?.dom` dereference in the mount effect (unlike `makeStubEditor`
// above, whose `{}` stub has a defined-but-view-less `editor` that never hit
// this line). Before the fix, this threw "Cannot read properties of null
// (reading 'view')" — the `useEditorState`/`BubbleMenu` mocks above still
// apply here, so the crash (or its absence) is isolated to that one line.
function makeNullEditor(): React.ComponentProps<typeof SelectionBubbleMenu>['editor'] {
  return null as unknown as React.ComponentProps<typeof SelectionBubbleMenu>['editor']
}

describe('#3061 — SelectionBubbleMenu raw editor-prop null safety', () => {
  it('renders without throwing when the `editor` prop itself is null', () => {
    expect(() => {
      render(<SelectionBubbleMenu editor={makeNullEditor()} />)
    }).not.toThrow()
  })

  it('passes axe audit with a null `editor` prop', async () => {
    const { container } = render(<SelectionBubbleMenu editor={makeNullEditor()} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})

// `capturedVirtualRef` is a module-level `let` reassigned inside the
// `PopoverAnchor` mock closure above, so TS's control-flow narrowing across
// the intervening `render()` call is unreliable (it can narrow to `never`
// after a `null` check). Isolate the null-check in its own explicitly-typed
// helper instead of narrowing the mutable variable inline in the test.
function requireCapturedVirtualRef(): {
  current: { getBoundingClientRect: () => DOMRect }
} {
  if (!capturedVirtualRef) throw new Error('PopoverAnchor virtualRef was not captured')
  return capturedVirtualRef
}

describe('#3061 — SelectionBubbleMenu link-popover anchor null safety', () => {
  it('virtualAnchorRef.getBoundingClientRect does not throw when editor is null', () => {
    capturedVirtualRef = null
    render(<SelectionBubbleMenu editor={makeNullEditor()} />)

    const ref = requireCapturedVirtualRef()
    expect(() => ref.current.getBoundingClientRect()).not.toThrow()
    expect(ref.current.getBoundingClientRect()).toBeInstanceOf(DOMRect)
  })
})
