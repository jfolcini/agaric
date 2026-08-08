import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

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

    expect(screen.getByRole('dialog')).toHaveClass('max-h-[calc(100dvh-2rem)]')
    expect(screen.getByRole('dialog')).not.toHaveClass('max-h-[80dvh]')
  })

  it('has no axe violations', async () => {
    render(<EmojiPickerDialog open onOpenChange={vi.fn()} onSelect={vi.fn()} />)

    expect(await axe(screen.getByRole('dialog'))).toHaveNoViolations()
  })
})
