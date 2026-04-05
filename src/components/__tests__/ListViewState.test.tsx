/**
 * Tests for ListViewState component.
 *
 * Validates the three-way branching logic:
 *  - loading + no items → skeleton (default or custom)
 *  - not loading + no items → empty state
 *  - items present → render children
 *
 * Also covers:
 *  - skeleton={null} opt-out
 *  - items shown even while loading (reload scenario)
 *  - children receive the correct items array
 *  - re-render transitions between states
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ListViewState } from '../ListViewState'

interface Item {
  id: string
  name: string
}

const sampleItems: Item[] = [
  { id: '1', name: 'Alpha' },
  { id: '2', name: 'Beta' },
  { id: '3', name: 'Gamma' },
]

describe('ListViewState', () => {
  // ── Skeleton (loading) state ────────────────────────────────────────

  describe('loading state (skeleton)', () => {
    it('renders default LoadingSkeleton when loading with no items', () => {
      const { container } = render(
        <ListViewState loading={true} items={[]} empty={<p>No items</p>}>
          {(items) => (
            <ul>
              {items.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
        </ListViewState>,
      )

      const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
      expect(skeletons.length).toBe(3)
    })

    it('renders custom skeleton when provided', () => {
      render(
        <ListViewState<Item>
          loading={true}
          items={[]}
          skeleton={<div data-testid="custom-skeleton">Loading...</div>}
          empty={<p>No items</p>}
        >
          {(items) => (
            <ul>
              {items.map((i) => (
                <li key={i.id}>{i.name}</li>
              ))}
            </ul>
          )}
        </ListViewState>,
      )

      expect(screen.getByTestId('custom-skeleton')).toBeInTheDocument()
      expect(screen.getByText('Loading...')).toBeInTheDocument()
    })

    it('renders nothing when skeleton is null', () => {
      const { container } = render(
        <ListViewState<Item> loading={true} items={[]} skeleton={null} empty={<p>No items</p>}>
          {(items) => (
            <ul>
              {items.map((i) => (
                <li key={i.id}>{i.name}</li>
              ))}
            </ul>
          )}
        </ListViewState>,
      )

      expect(container.innerHTML).toBe('')
    })

    it('does not render empty state while loading', () => {
      render(
        <ListViewState<Item> loading={true} items={[]} empty={<p>No items</p>}>
          {(items) => (
            <ul>
              {items.map((i) => (
                <li key={i.id}>{i.name}</li>
              ))}
            </ul>
          )}
        </ListViewState>,
      )

      expect(screen.queryByText('No items')).not.toBeInTheDocument()
    })

    it('does not render children while loading with empty items', () => {
      render(
        <ListViewState<Item> loading={true} items={[]} empty={<p>No items</p>}>
          {() => <div data-testid="children-content">Content</div>}
        </ListViewState>,
      )

      expect(screen.queryByTestId('children-content')).not.toBeInTheDocument()
    })
  })

  // ── Empty state ─────────────────────────────────────────────────────

  describe('empty state', () => {
    it('renders empty content when not loading and no items', () => {
      render(
        <ListViewState<Item> loading={false} items={[]} empty={<p>No items found</p>}>
          {(items) => (
            <ul>
              {items.map((i) => (
                <li key={i.id}>{i.name}</li>
              ))}
            </ul>
          )}
        </ListViewState>,
      )

      expect(screen.getByText('No items found')).toBeInTheDocument()
    })

    it('renders complex empty state content', () => {
      render(
        <ListViewState<Item>
          loading={false}
          items={[]}
          empty={
            <div data-testid="empty-state">
              <h2>Nothing here</h2>
              <p>Try adding some items</p>
            </div>
          }
        >
          {(items) => (
            <ul>
              {items.map((i) => (
                <li key={i.id}>{i.name}</li>
              ))}
            </ul>
          )}
        </ListViewState>,
      )

      expect(screen.getByTestId('empty-state')).toBeInTheDocument()
      expect(screen.getByText('Nothing here')).toBeInTheDocument()
      expect(screen.getByText('Try adding some items')).toBeInTheDocument()
    })

    it('does not render skeleton in empty state', () => {
      const { container } = render(
        <ListViewState<Item> loading={false} items={[]} empty={<p>No items</p>}>
          {(items) => (
            <ul>
              {items.map((i) => (
                <li key={i.id}>{i.name}</li>
              ))}
            </ul>
          )}
        </ListViewState>,
      )

      const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
      expect(skeletons.length).toBe(0)
    })

    it('does not render children in empty state', () => {
      render(
        <ListViewState<Item> loading={false} items={[]} empty={<p>No items</p>}>
          {() => <div data-testid="children-content">Content</div>}
        </ListViewState>,
      )

      expect(screen.queryByTestId('children-content')).not.toBeInTheDocument()
    })
  })

  // ── Loaded state (children) ─────────────────────────────────────────

  describe('loaded state (children)', () => {
    it('renders children when items are present and not loading', () => {
      render(
        <ListViewState<Item> loading={false} items={sampleItems} empty={<p>No items</p>}>
          {(items) => (
            <ul>
              {items.map((i) => (
                <li key={i.id}>{i.name}</li>
              ))}
            </ul>
          )}
        </ListViewState>,
      )

      expect(screen.getByText('Alpha')).toBeInTheDocument()
      expect(screen.getByText('Beta')).toBeInTheDocument()
      expect(screen.getByText('Gamma')).toBeInTheDocument()
    })

    it('passes the correct items array to children', () => {
      render(
        <ListViewState<Item> loading={false} items={sampleItems} empty={<p>No items</p>}>
          {(items) => <div data-testid="count">Count: {items.length}</div>}
        </ListViewState>,
      )

      expect(screen.getByText('Count: 3')).toBeInTheDocument()
    })

    it('renders children when loading but items exist (reload scenario)', () => {
      render(
        <ListViewState<Item> loading={true} items={sampleItems} empty={<p>No items</p>}>
          {(items) => (
            <ul>
              {items.map((i) => (
                <li key={i.id}>{i.name}</li>
              ))}
            </ul>
          )}
        </ListViewState>,
      )

      // Items should still be shown during reload
      expect(screen.getByText('Alpha')).toBeInTheDocument()
      expect(screen.getByText('Beta')).toBeInTheDocument()
      expect(screen.getByText('Gamma')).toBeInTheDocument()
    })

    it('does not show skeleton when loading with existing items', () => {
      const { container } = render(
        <ListViewState<Item> loading={true} items={sampleItems} empty={<p>No items</p>}>
          {(items) => (
            <ul>
              {items.map((i) => (
                <li key={i.id}>{i.name}</li>
              ))}
            </ul>
          )}
        </ListViewState>,
      )

      const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
      expect(skeletons.length).toBe(0)
    })

    it('does not show empty state when items are present', () => {
      render(
        <ListViewState<Item> loading={false} items={sampleItems} empty={<p>No items</p>}>
          {(items) => (
            <ul>
              {items.map((i) => (
                <li key={i.id}>{i.name}</li>
              ))}
            </ul>
          )}
        </ListViewState>,
      )

      expect(screen.queryByText('No items')).not.toBeInTheDocument()
    })
  })

  // ── State transitions ───────────────────────────────────────────────

  describe('state transitions', () => {
    it('transitions from skeleton to loaded', () => {
      const { rerender } = render(
        <ListViewState<Item> loading={true} items={[]} empty={<p>No items</p>}>
          {(items) => (
            <ul>
              {items.map((i) => (
                <li key={i.id}>{i.name}</li>
              ))}
            </ul>
          )}
        </ListViewState>,
      )

      // Initially shows skeleton
      expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(3)

      // Transition to loaded
      rerender(
        <ListViewState<Item> loading={false} items={sampleItems} empty={<p>No items</p>}>
          {(items) => (
            <ul>
              {items.map((i) => (
                <li key={i.id}>{i.name}</li>
              ))}
            </ul>
          )}
        </ListViewState>,
      )

      expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(0)
      expect(screen.getByText('Alpha')).toBeInTheDocument()
    })

    it('transitions from skeleton to empty', () => {
      const { rerender } = render(
        <ListViewState<Item> loading={true} items={[]} empty={<p>No items</p>}>
          {(items) => (
            <ul>
              {items.map((i) => (
                <li key={i.id}>{i.name}</li>
              ))}
            </ul>
          )}
        </ListViewState>,
      )

      // Initially shows skeleton
      expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(3)
      expect(screen.queryByText('No items')).not.toBeInTheDocument()

      // Transition to empty
      rerender(
        <ListViewState<Item> loading={false} items={[]} empty={<p>No items</p>}>
          {(items) => (
            <ul>
              {items.map((i) => (
                <li key={i.id}>{i.name}</li>
              ))}
            </ul>
          )}
        </ListViewState>,
      )

      expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(0)
      expect(screen.getByText('No items')).toBeInTheDocument()
    })

    it('transitions from loaded to empty', () => {
      const { rerender } = render(
        <ListViewState<Item> loading={false} items={sampleItems} empty={<p>No items</p>}>
          {(items) => (
            <ul>
              {items.map((i) => (
                <li key={i.id}>{i.name}</li>
              ))}
            </ul>
          )}
        </ListViewState>,
      )

      expect(screen.getByText('Alpha')).toBeInTheDocument()

      rerender(
        <ListViewState<Item> loading={false} items={[]} empty={<p>No items</p>}>
          {(items) => (
            <ul>
              {items.map((i) => (
                <li key={i.id}>{i.name}</li>
              ))}
            </ul>
          )}
        </ListViewState>,
      )

      expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
      expect(screen.getByText('No items')).toBeInTheDocument()
    })

    it('transitions from loaded to loading (reload keeps items visible)', () => {
      const { rerender } = render(
        <ListViewState<Item> loading={false} items={sampleItems} empty={<p>No items</p>}>
          {(items) => (
            <ul>
              {items.map((i) => (
                <li key={i.id}>{i.name}</li>
              ))}
            </ul>
          )}
        </ListViewState>,
      )

      expect(screen.getByText('Alpha')).toBeInTheDocument()

      // Start reload — items stay visible
      rerender(
        <ListViewState<Item> loading={true} items={sampleItems} empty={<p>No items</p>}>
          {(items) => (
            <ul>
              {items.map((i) => (
                <li key={i.id}>{i.name}</li>
              ))}
            </ul>
          )}
        </ListViewState>,
      )

      expect(screen.getByText('Alpha')).toBeInTheDocument()
      expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(0)
    })
  })

  // ── Edge cases ──────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('works with primitive item types', () => {
      render(
        <ListViewState<string>
          loading={false}
          items={['one', 'two', 'three']}
          empty={<p>No items</p>}
        >
          {(items) => (
            <ul>
              {items.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
        </ListViewState>,
      )

      expect(screen.getByText('one')).toBeInTheDocument()
      expect(screen.getByText('two')).toBeInTheDocument()
      expect(screen.getByText('three')).toBeInTheDocument()
    })

    it('works with a single item', () => {
      render(
        <ListViewState<Item>
          loading={false}
          items={[{ id: '1', name: 'Solo' }]}
          empty={<p>No items</p>}
        >
          {(items) => (
            <ul>
              {items.map((i) => (
                <li key={i.id}>{i.name}</li>
              ))}
            </ul>
          )}
        </ListViewState>,
      )

      expect(screen.getByText('Solo')).toBeInTheDocument()
    })

    it('renders custom skeleton with aria attributes', () => {
      render(
        <ListViewState<Item>
          loading={true}
          items={[]}
          skeleton={
            <div aria-busy="true" role="status">
              Loading content...
            </div>
          }
          empty={<p>No items</p>}
        >
          {(items) => (
            <ul>
              {items.map((i) => (
                <li key={i.id}>{i.name}</li>
              ))}
            </ul>
          )}
        </ListViewState>,
      )

      const status = screen.getByRole('status')
      expect(status).toHaveAttribute('aria-busy', 'true')
      expect(status).toHaveTextContent('Loading content...')
    })
  })
})
