/**
 * Tests for ResultCard component.
 *
 * Validates:
 *  - Renders block content
 *  - Shows badge for page/tag types
 *  - Calls onClick
 *  - Shows spinner when showSpinner=true
 *  - Renders children
 *  - Disabled state
 *  - Shows "(empty)" for empty content
 *  - axe a11y audit
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { BlockRow } from '../../lib/tauri'
import { ResultCard } from '../ResultCard'

const makeBlock = (overrides?: Partial<BlockRow>): BlockRow => ({
  id: 'BLOCK1',
  block_type: 'content',
  content: 'test content',
  parent_id: null,
  position: 1,
  deleted_at: null,
  is_conflict: false,
  conflict_type: null,
  todo_state: null,
  priority: null,
  due_date: null,
  scheduled_date: null,
  ...overrides,
})

describe('ResultCard', () => {
  it('renders block content', () => {
    render(<ResultCard block={makeBlock()} onClick={() => {}} />)
    expect(screen.getByText('test content')).toBeInTheDocument()
  })

  it('shows badge for page type', () => {
    render(<ResultCard block={makeBlock({ block_type: 'page' })} onClick={() => {}} />)
    expect(screen.getByText('page')).toBeInTheDocument()
  })

  it('shows badge for tag type', () => {
    render(<ResultCard block={makeBlock({ block_type: 'tag' })} onClick={() => {}} />)
    expect(screen.getByText('tag')).toBeInTheDocument()
  })

  it('does not show badge for content type', () => {
    render(<ResultCard block={makeBlock({ block_type: 'content' })} onClick={() => {}} />)
    expect(screen.queryByText('content')).not.toBeInTheDocument()
  })

  it('calls onClick when clicked', () => {
    const onClick = vi.fn()
    render(<ResultCard block={makeBlock()} onClick={onClick} />)

    fireEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('shows spinner when showSpinner=true', () => {
    const { container } = render(<ResultCard block={makeBlock()} onClick={() => {}} showSpinner />)
    expect(container.querySelector('.animate-spin')).toBeInTheDocument()
  })

  it('does not show spinner by default', () => {
    const { container } = render(<ResultCard block={makeBlock()} onClick={() => {}} />)
    expect(container.querySelector('.animate-spin')).not.toBeInTheDocument()
  })

  it('renders children below the main content', () => {
    render(
      <ResultCard block={makeBlock()} onClick={() => {}}>
        <p>breadcrumb info</p>
      </ResultCard>,
    )
    expect(screen.getByText('breadcrumb info')).toBeInTheDocument()
  })

  it('disables the button when disabled=true', () => {
    render(<ResultCard block={makeBlock()} onClick={() => {}} disabled />)
    expect(screen.getByRole('button')).toBeDisabled()
  })

  it('does not call onClick when disabled', () => {
    const onClick = vi.fn()
    render(<ResultCard block={makeBlock()} onClick={onClick} disabled />)

    fireEvent.click(screen.getByRole('button'))
    expect(onClick).not.toHaveBeenCalled()
  })

  it('shows "(empty)" for empty content', () => {
    render(<ResultCard block={makeBlock({ content: '' })} onClick={() => {}} />)
    expect(screen.getByText('(empty)')).toBeInTheDocument()
  })

  it('shows "(empty)" for null content', () => {
    render(<ResultCard block={makeBlock({ content: null })} onClick={() => {}} />)
    expect(screen.getByText('(empty)')).toBeInTheDocument()
  })

  it('applies contentClassName to the content span', () => {
    render(<ResultCard block={makeBlock()} onClick={() => {}} contentClassName="line-clamp-2" />)
    const span = screen.getByText('test content')
    expect(span).toHaveClass('line-clamp-2')
  })

  it('has no a11y violations', async () => {
    const { container } = render(<ResultCard block={makeBlock()} onClick={() => {}} />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with all features enabled', async () => {
    const { container } = render(
      <ResultCard block={makeBlock({ block_type: 'page' })} onClick={() => {}} showSpinner disabled>
        <p>child content</p>
      </ResultCard>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
