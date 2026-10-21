/**
 * Tests for EmojiPickerDialog's Dialog and mobile Sheet shells.
 *
 * #3336 — the picker used to hand-roll `max-h-[80dvh]` because `SheetContent`
 * carried no cap of its own. The cap now lives in the primitive, so this
 * call site must inherit it rather than restate a divergent value.
 */

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { EmojiPickerDialog } from '@/components/EmojiPicker/EmojiPickerDialog'
import { EDITOR_PORTAL_SELECTOR } from '@/editor/editor-portal'

vi.mock('@/components/EmojiPicker/EmojiPicker', () => ({
  EmojiPicker: () => <div data-testid="emoji-picker" />,
}))

const viewport = vi.hoisted(() => ({ mobile: true }))
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => viewport.mobile,
}))

describe('EmojiPickerDialog', () => {
  beforeEach(() => {
    viewport.mobile = true
  })

  // Opened from a block, the pick inserts at the roving editor's caret: focus
  // landing in the picker must read as an editor portal to `useEditorBlur`, or
  // the editor unmounts and the emoji goes into an editor holding no block.
  it.each([
    ['dialog', false],
    ['sheet', true],
  ])('the %s is an editor portal', (_shell, mobile) => {
    viewport.mobile = mobile
    render(<EmojiPickerDialog open onOpenChange={vi.fn()} onSelect={vi.fn()} />)

    expect(screen.getByTestId('emoji-picker').closest(EDITOR_PORTAL_SELECTOR)).toBe(
      screen.getByRole('dialog'),
    )
  })

  it('inherits the shared mobile sheet cap without a local height override', () => {
    render(<EmojiPickerDialog open onOpenChange={vi.fn()} onSelect={vi.fn()} />)

    const sheet = screen.getByRole('dialog')
    expect(sheet).toHaveClass('max-h-[calc(100dvh-3.5rem-var(--safe-area-top))]')
    expect(sheet).not.toHaveClass('max-h-[80dvh]')
  })

  it('has no axe violations', async () => {
    const { baseElement } = render(
      <EmojiPickerDialog open onOpenChange={vi.fn()} onSelect={vi.fn()} />,
    )

    const results = await axe(baseElement, { rules: { region: { enabled: false } } })
    expect(results).toHaveNoViolations()
  })
})
