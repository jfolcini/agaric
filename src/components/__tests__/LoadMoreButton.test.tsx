/**
 * Tests for LoadMoreButton component (R-3).
 *
 * Validates:
 *  1. Renders button when hasMore=true
 *  2. Returns null when hasMore=false
 *  3. Click fires onLoadMore callback
 *  4. Loading state shows spinner and disables button
 *  5. Custom labels are rendered
 *  6. Custom aria labels are applied
 *  7. A11y audit passes (axe)
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

  // 8. Custom className is applied
  it('applies custom className', () => {
    const onLoadMore = vi.fn()
    render(
      <LoadMoreButton
        hasMore={true}
        loading={false}
        onLoadMore={onLoadMore}
        className="my-custom-class"
      />,
    )

    // The cn mock joins classes with space
    const btn = screen.getByRole('button')
    expect(btn.className).toContain('my-custom-class')
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
})
