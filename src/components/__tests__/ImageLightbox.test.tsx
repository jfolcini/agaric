/**
 * Tests for ImageLightbox component.
 *
 * Validates:
 *  - Renders image when open
 *  - Does not render when closed
 *  - Close button closes the dialog
 *  - Escape key closes the dialog
 *  - Image has correct src and alt attributes
 *  - axe(container) a11y audit
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { ImageLightbox } from '../ImageLightbox'

describe('ImageLightbox', () => {
  const defaultProps = {
    src: 'https://example.com/photo.jpg',
    alt: 'A test photo',
    open: true,
    onOpenChange: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders image when open', () => {
    render(<ImageLightbox {...defaultProps} />)

    const img = screen.getByTestId('lightbox-image')
    expect(img).toBeInTheDocument()
    expect(img).toBeVisible()
  })

  it('does not render when closed', () => {
    render(<ImageLightbox {...defaultProps} open={false} />)

    expect(screen.queryByTestId('lightbox-image')).not.toBeInTheDocument()
  })

  it('close button closes the dialog', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()

    render(<ImageLightbox {...defaultProps} onOpenChange={onOpenChange} />)

    const closeButton = screen.getByRole('button', { name: /close/i })
    await user.click(closeButton)

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('Escape key closes the dialog', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()

    render(<ImageLightbox {...defaultProps} onOpenChange={onOpenChange} />)

    await user.keyboard('{Escape}')

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('image has correct src and alt attributes', () => {
    render(<ImageLightbox {...defaultProps} />)

    const img = screen.getByTestId('lightbox-image')
    expect(img).toHaveAttribute('src', 'https://example.com/photo.jpg')
    expect(img).toHaveAttribute('alt', 'A test photo')
  })

  it('renders open externally button when onOpenExternal is provided', () => {
    render(<ImageLightbox {...defaultProps} onOpenExternal={vi.fn()} />)

    expect(screen.getByTestId('lightbox-open-external')).toBeInTheDocument()
    expect(screen.getByText('Open externally')).toBeInTheDocument()
  })

  it('does not render open externally button when onOpenExternal is not provided', () => {
    render(<ImageLightbox {...defaultProps} />)

    expect(screen.queryByTestId('lightbox-open-external')).not.toBeInTheDocument()
  })

  it('calls onOpenExternal when open externally button is clicked', async () => {
    const user = userEvent.setup()
    const onOpenExternal = vi.fn()

    render(<ImageLightbox {...defaultProps} onOpenExternal={onOpenExternal} />)

    await user.click(screen.getByTestId('lightbox-open-external'))

    expect(onOpenExternal).toHaveBeenCalledTimes(1)
  })

  it('has no a11y violations when open', async () => {
    const { container } = render(<ImageLightbox {...defaultProps} />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations when open with external button', async () => {
    const { container } = render(<ImageLightbox {...defaultProps} onOpenExternal={vi.fn()} />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
