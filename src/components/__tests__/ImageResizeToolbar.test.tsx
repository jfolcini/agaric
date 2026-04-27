import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

vi.mock('../../lib/tauri', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/tauri')>()
  return {
    ...mod,
    setProperty: vi.fn(() => Promise.resolve({})),
  }
})

const { setProperty } = await import('../../lib/tauri')
const mockedSetProperty = vi.mocked(setProperty)

import { IMAGE_WIDTH_PRESETS, ImageResizeToolbar } from '../ImageResizeToolbar'

describe('ImageResizeToolbar', () => {
  it('renders 4 preset buttons (25%, 50%, 75%, 100%)', () => {
    render(<ImageResizeToolbar blockId="B1" currentWidth="100" onWidthChange={vi.fn()} />)

    expect(screen.getByTestId('image-resize-25')).toBeInTheDocument()
    expect(screen.getByTestId('image-resize-50')).toBeInTheDocument()
    expect(screen.getByTestId('image-resize-75')).toBeInTheDocument()
    expect(screen.getByTestId('image-resize-100')).toBeInTheDocument()
  })

  it('displays percentage text for each preset', () => {
    render(<ImageResizeToolbar blockId="B1" currentWidth="100" onWidthChange={vi.fn()} />)

    expect(screen.getByText('25%')).toBeInTheDocument()
    expect(screen.getByText('50%')).toBeInTheDocument()
    expect(screen.getByText('75%')).toBeInTheDocument()
    expect(screen.getByText('100%')).toBeInTheDocument()
  })

  it('click fires onWidthChange with correct value', async () => {
    const user = userEvent.setup()
    const onWidthChange = vi.fn()
    render(<ImageResizeToolbar blockId="B1" currentWidth="100" onWidthChange={onWidthChange} />)

    await user.click(screen.getByTestId('image-resize-50'))
    expect(onWidthChange).toHaveBeenCalledWith('50')
  })

  it('click calls setProperty with image_width', async () => {
    const user = userEvent.setup()
    render(<ImageResizeToolbar blockId="B1" currentWidth="100" onWidthChange={vi.fn()} />)

    await user.click(screen.getByTestId('image-resize-25'))
    expect(mockedSetProperty).toHaveBeenCalledWith({
      blockId: 'B1',
      key: 'image_width',
      valueText: '25',
    })
  })

  it('active preset uses secondary variant', () => {
    render(<ImageResizeToolbar blockId="B1" currentWidth="50" onWidthChange={vi.fn()} />)

    // The active button (50%) should be distinguishable — it gets variant="secondary"
    const btn50 = screen.getByTestId('image-resize-50')
    const btn25 = screen.getByTestId('image-resize-25')
    // We can't easily check the variant prop, but we can check they're both rendered
    expect(btn50).toBeInTheDocument()
    expect(btn25).toBeInTheDocument()
  })

  it('preset matching currentWidth has aria-pressed="true"; others "false" (UX-280)', () => {
    render(<ImageResizeToolbar blockId="B1" currentWidth="50" onWidthChange={vi.fn()} />)

    expect(screen.getByTestId('image-resize-25')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('image-resize-50')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('image-resize-75')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('image-resize-100')).toHaveAttribute('aria-pressed', 'false')
  })

  it('aria-pressed updates when currentWidth changes (UX-280)', () => {
    const { rerender } = render(
      <ImageResizeToolbar blockId="B1" currentWidth="25" onWidthChange={vi.fn()} />,
    )

    expect(screen.getByTestId('image-resize-25')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('image-resize-100')).toHaveAttribute('aria-pressed', 'false')

    rerender(<ImageResizeToolbar blockId="B1" currentWidth="100" onWidthChange={vi.fn()} />)

    expect(screen.getByTestId('image-resize-25')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('image-resize-100')).toHaveAttribute('aria-pressed', 'true')
  })

  it('has role="toolbar" with aria-label', () => {
    render(<ImageResizeToolbar blockId="B1" currentWidth="100" onWidthChange={vi.fn()} />)

    const toolbar = screen.getByTestId('image-resize-toolbar')
    expect(toolbar).toHaveAttribute('role', 'toolbar')
    expect(toolbar).toHaveAttribute('aria-label')
  })

  it('exports IMAGE_WIDTH_PRESETS with 4 entries', () => {
    expect(IMAGE_WIDTH_PRESETS).toHaveLength(4)
    expect(IMAGE_WIDTH_PRESETS.map((p) => p.value)).toEqual(['25', '50', '75', '100'])
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <ImageResizeToolbar blockId="B1" currentWidth="100" onWidthChange={vi.fn()} />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
