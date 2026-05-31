/**
 * Tests for ImageLightbox component.
 *
 * Validates:
 *  - Renders the current image when open; nothing when closed
 *  - Close button / Escape close the dialog (Radix-provided)
 *  - Single image: no nav chrome, arrow keys ignored
 *  - Multiple images: prev/next buttons + counter, arrow-key navigation,
 *    end-clamping disables the boundary button, out-of-range index clamps
 *  - Open-externally button callback
 *  - axe(container) a11y audit
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { ImageLightbox, type LightboxImage } from '../ImageLightbox'

const IMAGES: LightboxImage[] = [
  { src: 'blob:one', alt: 'one.png' },
  { src: 'blob:two', alt: 'two.png' },
  { src: 'blob:three', alt: 'three.png' },
]

const SINGLE: LightboxImage[] = [{ src: 'blob:one', alt: 'one.png' }]

const noop = (): void => {}

function renderLightbox(
  props: Partial<React.ComponentProps<typeof ImageLightbox>> = {},
): ReturnType<typeof vi.fn> {
  const onIndexChange = vi.fn()
  render(
    <ImageLightbox
      images={IMAGES}
      index={0}
      onIndexChange={onIndexChange}
      open
      onOpenChange={vi.fn()}
      {...props}
    />,
  )
  return onIndexChange
}

describe('ImageLightbox', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the current image when open', () => {
    renderLightbox()
    const img = screen.getByTestId('lightbox-image')
    expect(img).toBeVisible()
    expect(img).toHaveAttribute('src', 'blob:one')
    expect(img).toHaveAttribute('alt', 'one.png')
  })

  it('does not render the image when closed', () => {
    renderLightbox({ open: false })
    expect(screen.queryByTestId('lightbox-image')).not.toBeInTheDocument()
  })

  it('renders nothing when there are no images', () => {
    const { container } = render(
      <ImageLightbox images={[]} index={0} onIndexChange={noop} open onOpenChange={noop} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('Escape key closes the dialog (Radix)', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    renderLightbox({ onOpenChange })
    await user.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('renders the open-externally button only when onOpenExternal is provided', () => {
    const { rerender } = render(
      <ImageLightbox images={IMAGES} index={0} onIndexChange={noop} open onOpenChange={noop} />,
    )
    expect(screen.queryByTestId('lightbox-open-external')).not.toBeInTheDocument()
    rerender(
      <ImageLightbox
        images={IMAGES}
        index={0}
        onIndexChange={noop}
        open
        onOpenChange={noop}
        onOpenExternal={vi.fn()}
      />,
    )
    expect(screen.getByTestId('lightbox-open-external')).toBeInTheDocument()
  })

  it('calls onOpenExternal when the external button is clicked', async () => {
    const user = userEvent.setup()
    const onOpenExternal = vi.fn()
    renderLightbox({ onOpenExternal })
    await user.click(screen.getByTestId('lightbox-open-external'))
    expect(onOpenExternal).toHaveBeenCalledTimes(1)
  })

  describe('single image', () => {
    it('shows no navigation chrome', () => {
      render(
        <ImageLightbox images={SINGLE} index={0} onIndexChange={noop} open onOpenChange={noop} />,
      )
      expect(screen.queryByTestId('lightbox-prev')).not.toBeInTheDocument()
      expect(screen.queryByTestId('lightbox-next')).not.toBeInTheDocument()
      expect(screen.queryByTestId('lightbox-counter')).not.toBeInTheDocument()
    })

    it('ignores arrow keys (no navigation)', async () => {
      const user = userEvent.setup()
      const onIndexChange = vi.fn()
      render(
        <ImageLightbox
          images={SINGLE}
          index={0}
          onIndexChange={onIndexChange}
          open
          onOpenChange={noop}
        />,
      )
      await user.keyboard('{ArrowRight}{ArrowLeft}')
      expect(onIndexChange).not.toHaveBeenCalled()
    })
  })

  describe('multiple images', () => {
    it('shows prev/next buttons and a counter', () => {
      renderLightbox({ index: 1 })
      expect(screen.getByTestId('lightbox-prev')).toBeInTheDocument()
      expect(screen.getByTestId('lightbox-next')).toBeInTheDocument()
      expect(screen.getByTestId('lightbox-counter')).toHaveTextContent('2 of 3')
    })

    it('navigates to the next image when Next is clicked', async () => {
      const user = userEvent.setup()
      const onIndexChange = renderLightbox({ index: 0 })
      await user.click(screen.getByTestId('lightbox-next'))
      expect(onIndexChange).toHaveBeenCalledWith(1)
    })

    it('navigates to the previous image when Prev is clicked', async () => {
      const user = userEvent.setup()
      const onIndexChange = renderLightbox({ index: 2 })
      await user.click(screen.getByTestId('lightbox-prev'))
      expect(onIndexChange).toHaveBeenCalledWith(1)
    })

    it('navigates with ArrowRight / ArrowLeft keys (controlled)', async () => {
      const user = userEvent.setup()
      function Harness(): React.ReactElement {
        const [index, setIndex] = React.useState(1)
        return (
          <ImageLightbox
            images={IMAGES}
            index={index}
            onIndexChange={setIndex}
            open
            onOpenChange={noop}
          />
        )
      }
      render(<Harness />)
      expect(screen.getByTestId('lightbox-counter')).toHaveTextContent('2 of 3')
      await user.keyboard('{ArrowRight}')
      expect(screen.getByTestId('lightbox-counter')).toHaveTextContent('3 of 3')
      expect(screen.getByTestId('lightbox-image')).toHaveAttribute('src', 'blob:three')
      await user.keyboard('{ArrowLeft}')
      await user.keyboard('{ArrowLeft}')
      expect(screen.getByTestId('lightbox-counter')).toHaveTextContent('1 of 3')
      expect(screen.getByTestId('lightbox-image')).toHaveAttribute('src', 'blob:one')
    })

    it('disables Prev at the first image and does not navigate via key', async () => {
      const user = userEvent.setup()
      const onIndexChange = renderLightbox({ index: 0 })
      expect(screen.getByTestId('lightbox-prev')).toBeDisabled()
      await user.keyboard('{ArrowLeft}')
      expect(onIndexChange).not.toHaveBeenCalled()
    })

    it('disables Next at the last image and does not navigate via key', async () => {
      const user = userEvent.setup()
      const onIndexChange = renderLightbox({ index: 2 })
      expect(screen.getByTestId('lightbox-next')).toBeDisabled()
      await user.keyboard('{ArrowRight}')
      expect(onIndexChange).not.toHaveBeenCalled()
    })

    it('clamps an out-of-range index to the last image', () => {
      renderLightbox({ index: 99 })
      expect(screen.getByTestId('lightbox-image')).toHaveAttribute('src', 'blob:three')
      expect(screen.getByTestId('lightbox-next')).toBeDisabled()
    })

    it('has no a11y violations', async () => {
      const { container } = render(
        <ImageLightbox images={IMAGES} index={1} onIndexChange={noop} open onOpenChange={noop} />,
      )
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
