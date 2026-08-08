/**
 * Tests for EmojiPickerDialog's mobile Sheet shell (#3336).
 *
 * The picker used to hand-roll `max-h-[80dvh]` because `SheetContent`
 * carried no cap of its own. The cap now lives in the primitive, so this
 * call site must inherit it rather than restate a divergent value.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { EmojiPickerDialog } from '@/components/EmojiPicker/EmojiPickerDialog'

vi.mock('@/components/EmojiPicker/EmojiPicker', () => ({
  EmojiPicker: () => <div data-testid="emoji-picker" />,
}))

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => true,
}))

describe('EmojiPickerDialog', () => {
  it('inherits the shared mobile sheet cap without a local height override', () => {
    render(<EmojiPickerDialog open onOpenChange={vi.fn()} onSelect={vi.fn()} />)

    const sheet = screen.getByRole('dialog')
    expect(sheet).toHaveClass('max-h-[calc(100dvh-2rem)]')
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
