/**
 * Tests for DependencyIndicator component (F-37).
 *
 * Validates:
 *  1. Shows Link2 icon when block has `blocked_by` property
 *  2. Shows nothing when block has no `blocked_by` property
 *  3. Tooltip shows "Blocked by" text
 *  4. axe a11y audit
 */

import { render, screen, waitFor } from '@testing-library/react'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

const mockGetProperties = vi.fn()
const mockBatchResolve = vi.fn()

vi.mock('../../lib/tauri', () => ({
  getProperties: (...args: unknown[]) => mockGetProperties(...args),
  batchResolve: (...args: unknown[]) => mockBatchResolve(...args),
}))

vi.mock('lucide-react', () => ({
  Link2: (props: Record<string, unknown>) => <svg data-testid="icon-link2" {...props} />,
}))

import { DependencyIndicator, type DependencyIndicatorProps } from '../DependencyIndicator'

function makeCache(): React.MutableRefObject<Map<string, unknown[]>> {
  return { current: new Map() }
}

function defaultProps(overrides: Partial<DependencyIndicatorProps> = {}): DependencyIndicatorProps {
  return {
    blockId: 'B1',
    propertiesCache: makeCache() as DependencyIndicatorProps['propertiesCache'],
    ...overrides,
  }
}

describe('DependencyIndicator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetProperties.mockResolvedValue([])
    mockBatchResolve.mockResolvedValue([])
  })

  it('shows nothing when block has no blocked_by property', async () => {
    mockGetProperties.mockResolvedValue([
      { key: 'effort', value_text: '2h', value_num: null, value_date: null, value_ref: null },
    ])

    const { container } = render(<DependencyIndicator {...defaultProps()} />)

    // Wait for the async effect to settle
    await waitFor(() => {
      expect(mockGetProperties).toHaveBeenCalledWith('B1')
    })

    expect(screen.queryByTestId('dependency-indicator')).not.toBeInTheDocument()
    expect(container.innerHTML).toBe('')
  })

  it('shows nothing when blocked_by has no value_ref', async () => {
    mockGetProperties.mockResolvedValue([
      {
        key: 'blocked_by',
        value_text: 'some text',
        value_num: null,
        value_date: null,
        value_ref: null,
      },
    ])

    const { container } = render(<DependencyIndicator {...defaultProps()} />)

    await waitFor(() => {
      expect(mockGetProperties).toHaveBeenCalledWith('B1')
    })

    expect(screen.queryByTestId('dependency-indicator')).not.toBeInTheDocument()
    expect(container.innerHTML).toBe('')
  })

  it('shows Link2 icon when block has blocked_by property with value_ref', async () => {
    mockGetProperties.mockResolvedValue([
      {
        key: 'blocked_by',
        value_text: null,
        value_num: null,
        value_date: null,
        value_ref: 'BLOCKING_BLOCK',
      },
    ])
    mockBatchResolve.mockResolvedValue([
      { id: 'BLOCKING_BLOCK', title: 'Fix login bug', block_type: 'block', deleted: false },
    ])

    render(<DependencyIndicator {...defaultProps()} />)

    await waitFor(() => {
      expect(screen.getByTestId('dependency-indicator')).toBeInTheDocument()
    })

    expect(screen.getByTestId('icon-link2')).toBeInTheDocument()
  })

  it('shows "Blocked by: {title}" in aria-label when title is resolved', async () => {
    mockGetProperties.mockResolvedValue([
      {
        key: 'blocked_by',
        value_text: null,
        value_num: null,
        value_date: null,
        value_ref: 'BLOCKING_BLOCK',
      },
    ])
    mockBatchResolve.mockResolvedValue([
      { id: 'BLOCKING_BLOCK', title: 'Fix login bug', block_type: 'block', deleted: false },
    ])

    render(<DependencyIndicator {...defaultProps()} />)

    await waitFor(() => {
      expect(screen.getByTestId('dependency-indicator')).toHaveAttribute(
        'aria-label',
        expect.stringContaining('Blocked by'),
      )
    })

    expect(screen.getByTestId('dependency-indicator')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('Fix login bug'),
    )
  })

  it('shows fallback aria-label when title resolution fails', async () => {
    mockGetProperties.mockResolvedValue([
      {
        key: 'blocked_by',
        value_text: null,
        value_num: null,
        value_date: null,
        value_ref: 'UNKNOWN_BLOCK',
      },
    ])
    mockBatchResolve.mockRejectedValue(new Error('not found'))

    render(<DependencyIndicator {...defaultProps()} />)

    await waitFor(() => {
      expect(screen.getByTestId('dependency-indicator')).toBeInTheDocument()
    })

    expect(screen.getByTestId('dependency-indicator')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('Blocked by'),
    )
  })

  it('uses cache to avoid redundant property fetches', async () => {
    const cache = makeCache() as DependencyIndicatorProps['propertiesCache']
    cache.current.set('B1', [
      { key: 'blocked_by', value_text: null, value_num: null, value_date: null, value_ref: 'REF1' },
    ])
    mockBatchResolve.mockResolvedValue([
      { id: 'REF1', content: 'Cached task', block_type: 'block', deleted: false },
    ])

    render(<DependencyIndicator {...defaultProps({ propertiesCache: cache })} />)

    await waitFor(() => {
      expect(screen.getByTestId('dependency-indicator')).toBeInTheDocument()
    })

    // Should NOT have called getProperties since it was cached
    expect(mockGetProperties).not.toHaveBeenCalled()
  })

  it('a11y: no violations when indicator is shown', async () => {
    mockGetProperties.mockResolvedValue([
      {
        key: 'blocked_by',
        value_text: null,
        value_num: null,
        value_date: null,
        value_ref: 'BLOCK_REF',
      },
    ])
    mockBatchResolve.mockResolvedValue([
      { id: 'BLOCK_REF', content: 'Dependency task', block_type: 'block', deleted: false },
    ])

    const { container } = render(<DependencyIndicator {...defaultProps()} />)

    await waitFor(() => {
      expect(screen.getByTestId('dependency-indicator')).toBeInTheDocument()
    })

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('a11y: no violations when indicator is hidden', async () => {
    mockGetProperties.mockResolvedValue([])

    const { container } = render(<DependencyIndicator {...defaultProps()} />)

    await waitFor(() => {
      expect(mockGetProperties).toHaveBeenCalled()
    })

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
