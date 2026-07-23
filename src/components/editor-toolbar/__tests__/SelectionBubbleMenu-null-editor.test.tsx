/**
 * Null-editor safety test (#3056) for `SelectionBubbleMenu`.
 *
 * Companion to `null-editor-safety.test.tsx` (FormattingToolbar / FormatMenu /
 * TurnIntoMenu), split into its own file because `SelectionBubbleMenu` needs a
 * different rig: unlike the other three, it also dereferences the raw
 * `editor` prop directly during a mount effect (`editor.view?.dom`, to wire
 * up the `open-link-popover` listener) — a separate, pre-existing null-safety
 * gap that is NOT part of this fix (the fix only guards the `useEditorState`
 * selector's `.isActive()`/`.can()` calls). Passing a literal `null` `editor`
 * prop here would trip that unrelated line, not the guard under test.
 *
 * So this file mocks `@tiptap/react`'s `useEditorState` to invoke the
 * component's REAL (unmodified) selector with `ctx.editor: null` — exactly
 * mirroring what TipTap's internal `EditorStateManager` snapshot looks like
 * during the mount/teardown race — while the component still receives a
 * normal, non-null `editor` object for everything else it touches at render
 * time. This isolates the exact code path the fix changed.
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
