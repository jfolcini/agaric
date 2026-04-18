/**
 * Tests for LoadMoreButton component (R-3, UX-3).
 *
 * Validates:
 *  1. Renders button when hasMore=true
 *  2. Returns null when hasMore=false
 *  3. Click fires onLoadMore callback
 *  4. Loading state shows spinner and disables button
 *  5. Custom labels are rendered (override i18n defaults)
 *  6. Custom aria labels are applied
 *  7. A11y audit passes (axe)
 *  8. i18n default label resolves to "Load more"
 *  9. i18n loading label resolves to "Loading…"
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { LoadMoreButton } from '../LoadMoreButton'

vi.mock('lucide-react', () => ({
  Loader2: (props: Record<string, unknown>) => <svg data-testid="loader-spinner" {...props} />,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string
    size?: string
  }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}))

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('LoadMoreButton', () => {
  // 1. Renders button when hasMore=true
  it('renders button when hasMore is true', () => {
    const onLoadMore = vi.fn()
    render(<LoadMoreButton hasMore={true} loading={false} onLoadMore={onLoadMore} />)

    const btn = screen.getByRole('button', { name: 'Load more' })
    expect(btn).toBeInTheDocument()
    expect(btn).not.toBeDisabled()
  })

  // 2. Returns null when hasMore=false
  it('returns null when hasMore is false', () => {
    const onLoadMore = vi.fn()
    const { container } = render(
      <LoadMoreButton hasMore={false} loading={false} onLoadMore={onLoadMore} />,
    )

    expect(container.innerHTML).toBe('')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  // 3. Click fires onLoadMore callback
  it('fires onLoadMore on click', async () => {
    const user = userEvent.setup()
    const onLoadMore = vi.fn()
    render(<LoadMoreButton hasMore={true} loading={false} onLoadMore={onLoadMore} />)

    await user.click(screen.getByRole('button', { name: 'Load more' }))

    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  // 4. Loading state shows spinner and disables button
  it('shows spinner and disables button when loading', () => {
    const onLoadMore = vi.fn()
    render(<LoadMoreButton hasMore={true} loading={true} onLoadMore={onLoadMore} />)

    const btn = screen.getByRole('button')
    expect(btn).toBeDisabled()
    expect(screen.getByTestId('loader-spinner')).toBeInTheDocument()
    expect(btn).toHaveTextContent('Loading\u2026')
  })

  // 4b. Loading state uses custom loadingLabel
  it('uses custom loadingLabel when loading', () => {
    const onLoadMore = vi.fn()
    render(
      <LoadMoreButton
        hasMore={true}
        loading={true}
        onLoadMore={onLoadMore}
        loadingLabel="Fetching..."
      />,
    )

    expect(screen.getByRole('button')).toHaveTextContent('Fetching...')
  })

  // 5. Custom labels are rendered
  it('renders custom label', () => {
    const onLoadMore = vi.fn()
    render(
      <LoadMoreButton hasMore={true} loading={false} onLoadMore={onLoadMore} label="Show more" />,
    )

    expect(screen.getByRole('button', { name: 'Show more' })).toBeInTheDocument()
  })

  // 6. Custom aria labels are applied
  it('applies custom aria labels', () => {
    const onLoadMore = vi.fn()
    render(
      <LoadMoreButton
        hasMore={true}
        loading={false}
        onLoadMore={onLoadMore}
        ariaLabel="Load more references"
        ariaLoadingLabel="Loading more references"
      />,
    )

    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Load more references')
  })

  // 6b. Loading aria label
  it('applies loading aria label when loading', () => {
    const onLoadMore = vi.fn()
    render(
      <LoadMoreButton
        hasMore={true}
        loading={true}
        onLoadMore={onLoadMore}
        ariaLabel="Load more references"
        ariaLoadingLabel="Loading more references"
      />,
    )

    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Loading more references')
  })

  // 7. aria-busy reflects loading state
  it('sets aria-busy when loading', () => {
    const onLoadMore = vi.fn()
    render(<LoadMoreButton hasMore={true} loading={true} onLoadMore={onLoadMore} />)

    expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true')
  })

  it('sets aria-busy=false when not loading', () => {
    const onLoadMore = vi.fn()
    render(<LoadMoreButton hasMore={true} loading={false} onLoadMore={onLoadMore} />)

    expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'false')
  })

  // 8. Custom className is applied to the wrapper
  it('applies custom className to the wrapper', () => {
    const onLoadMore = vi.fn()
    const { container } = render(
      <LoadMoreButton
        hasMore={true}
        loading={false}
        onLoadMore={onLoadMore}
        className="my-custom-class"
      />,
    )

    // The className is applied to the outer wrapper (so layout styles apply to
    // both the button and the optional progress line).
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).toContain('my-custom-class')
  })

  // 9. A11y audit passes (axe)
  it('has no a11y violations', async () => {
    const onLoadMore = vi.fn()
    const { container } = render(
      <LoadMoreButton hasMore={true} loading={false} onLoadMore={onLoadMore} />,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // 9b. A11y audit in loading state
  it('has no a11y violations in loading state', async () => {
    const onLoadMore = vi.fn()
    const { container } = render(
      <LoadMoreButton hasMore={true} loading={true} onLoadMore={onLoadMore} />,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // 10. i18n default label resolves to "Load more" (UX-3)
  it('default label resolves from i18n to "Load more"', () => {
    const onLoadMore = vi.fn()
    render(<LoadMoreButton hasMore={true} loading={false} onLoadMore={onLoadMore} />)

    const btn = screen.getByRole('button')
    expect(btn).toHaveTextContent('Load more')
  })

  // 11. i18n loading label resolves to "Loading…" (UX-3)
  it('default loading label resolves from i18n to "Loading…"', () => {
    const onLoadMore = vi.fn()
    render(<LoadMoreButton hasMore={true} loading={true} onLoadMore={onLoadMore} />)

    const btn = screen.getByRole('button')
    expect(btn).toHaveTextContent('Loading\u2026')
  })

  // 12. Custom labels override i18n defaults (UX-3)
  it('custom labels override i18n defaults', () => {
    const onLoadMore = vi.fn()
    render(
      <LoadMoreButton
        hasMore={true}
        loading={false}
        onLoadMore={onLoadMore}
        label="Fetch more"
        loadingLabel="Fetching…"
      />,
    )

    expect(screen.getByRole('button')).toHaveTextContent('Fetch more')
  })

  // UX-218 progress indicator
  describe('UX-218 progress indicator', () => {
    it('does not render progress when counts are omitted', () => {
      render(<LoadMoreButton hasMore={true} loading={false} onLoadMore={vi.fn()} />)
      expect(screen.queryByTestId('load-more-progress')).not.toBeInTheDocument()
    })

    it('renders "Loaded X of Y" progress line when both counts are provided', () => {
      render(
        <LoadMoreButton
          hasMore={true}
          loading={false}
          onLoadMore={vi.fn()}
          loadedCount={20}
          totalCount={245}
        />,
      )
      const progress = screen.getByTestId('load-more-progress')
      expect(progress).toBeInTheDocument()
      expect(progress.textContent).toBe('Loaded 20 of 245')
    })

    it('does not render progress when totalCount is 0', () => {
      render(
        <LoadMoreButton
          hasMore={true}
          loading={false}
          onLoadMore={vi.fn()}
          loadedCount={0}
          totalCount={0}
        />,
      )
      expect(screen.queryByTestId('load-more-progress')).not.toBeInTheDocument()
    })

    it('does not render progress when only loadedCount is provided', () => {
      render(<LoadMoreButton hasMore={true} loading={false} onLoadMore={vi.fn()} loadedCount={5} />)
      expect(screen.queryByTestId('load-more-progress')).not.toBeInTheDocument()
    })

    it('does not render progress when only totalCount is provided', () => {
      render(
        <LoadMoreButton hasMore={true} loading={false} onLoadMore={vi.fn()} totalCount={100} />,
      )
      expect(screen.queryByTestId('load-more-progress')).not.toBeInTheDocument()
    })

    it('renders progress alongside the spinner while loading', () => {
      render(
        <LoadMoreButton
          hasMore={true}
          loading={true}
          onLoadMore={vi.fn()}
          loadedCount={10}
          totalCount={50}
        />,
      )
      expect(screen.getByTestId('load-more-progress')).toHaveTextContent('Loaded 10 of 50')
      expect(screen.getByRole('button')).toBeDisabled()
    })

    it('has no a11y violations when rendering progress', async () => {
      const { container } = render(
        <LoadMoreButton
          hasMore={true}
          loading={false}
          onLoadMore={vi.fn()}
          loadedCount={20}
          totalCount={245}
        />,
      )
      await waitFor(async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      })
    })
  })
})
