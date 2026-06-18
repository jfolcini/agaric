/**
 * Tests for LocalGraphControl — the "focus on this page" toggle + hop
 * selector (#1429).
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { LocalGraphControl } from '@/components/graph/LocalGraphControl'

function setup(overrides: Partial<React.ComponentProps<typeof LocalGraphControl>> = {}) {
  const props: React.ComponentProps<typeof LocalGraphControl> = {
    active: false,
    onToggle: vi.fn(),
    hops: 2,
    onHopsChange: vi.fn(),
    seedLabel: 'My Page',
    ...overrides,
  }
  const utils = render(<LocalGraphControl {...props} />)
  return { ...utils, props }
}

describe('LocalGraphControl', () => {
  it('renders the focus toggle enabled when a page is open', () => {
    setup()
    const toggle = screen.getByTestId('local-graph-toggle')
    expect(toggle).toBeEnabled()
    expect(toggle).toHaveTextContent('Focus on this page')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
  })

  it('disables the toggle when no page is open', () => {
    setup({ seedLabel: null })
    expect(screen.getByTestId('local-graph-toggle')).toBeDisabled()
  })

  it('calls onToggle(true) when the toggle is clicked from the off state', () => {
    const { props } = setup({ active: false })
    fireEvent.click(screen.getByTestId('local-graph-toggle'))
    expect(props.onToggle).toHaveBeenCalledWith(true)
  })

  it('shows the exit label, seed name, and hop control when active', () => {
    setup({ active: true })
    const toggle = screen.getByTestId('local-graph-toggle')
    expect(toggle).toHaveTextContent('Exit focus')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('local-graph-seed-label')).toHaveTextContent(
      'Showing neighbors of "My Page"',
    )
    expect(screen.getByTestId('local-graph-hops')).toBeInTheDocument()
  })

  it('calls onToggle(false) when active and clicked', () => {
    const { props } = setup({ active: true })
    fireEvent.click(screen.getByTestId('local-graph-toggle'))
    expect(props.onToggle).toHaveBeenCalledWith(false)
  })

  it('hides the hop control when inactive', () => {
    setup({ active: false })
    expect(screen.queryByTestId('local-graph-hops')).not.toBeInTheDocument()
  })

  it('changes the hop depth via the segmented control', () => {
    const { props } = setup({ active: true, hops: 2 })
    fireEvent.click(screen.getByRole('radio', { name: '1 hop' }))
    expect(props.onHopsChange).toHaveBeenCalledWith(1)
  })

  it('has no a11y violations (inactive)', async () => {
    const { container } = setup({ active: false })
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no a11y violations (active)', async () => {
    const { container } = setup({ active: true })
    expect(await axe(container)).toHaveNoViolations()
  })
})
