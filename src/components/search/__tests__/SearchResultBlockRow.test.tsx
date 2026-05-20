/**
 * Tests for `SearchResultBlockRow` — the single search result row with
 * snippet highlighting (PEND-50 Phase 1).
 *
 * Covers the row chrome (focus state, click handler, role=option,
 * loading spinner, badge for page/tag rows) plus the snippet fallback
 * for rows with no FTS snippet (page-name-only hits).
 *
 * The row is rendered as a `role="option"` `<li>` (not a `<button>`) so
 * the `<li>` can sit inside a `role="listbox"` without violating axe's
 * `nested-interactive` rule.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SearchBlockRow as SearchBlockRowT } from '@/lib/bindings'
import { SearchResultBlockRow } from '../SearchResultBlockRow'

function makeRow(overrides: Partial<SearchBlockRowT> = {}): SearchBlockRowT {
  return {
    id: 'BLK1',
    block_type: 'content',
    content: 'content text',
    parent_id: null,
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: 'PAGE1',
    snippet: null,
    ...overrides,
  }
}

describe('SearchResultBlockRow', () => {
  it('renders a role=option <li> with the focus state applied', () => {
    render(
      <ul>
        <SearchResultBlockRow row={makeRow()} isFocused={true} onClick={() => {}} />
      </ul>,
    )
    const option = screen.getByRole('option')
    expect(option).toHaveAttribute('aria-selected', 'true')
    expect(option.tagName).toBe('LI')
  })

  it('renders the snippet with highlights when `row.snippet` is set', () => {
    render(
      <ul>
        <SearchResultBlockRow
          row={makeRow({ snippet: 'hello <mark>alpha</mark> world' })}
          isFocused={false}
          onClick={() => {}}
        />
      </ul>,
    )
    const marks = document.querySelectorAll('mark.search-result-mark')
    expect(marks).toHaveLength(1)
    expect(marks[0]?.textContent).toBe('alpha')
  })

  it('falls back to `row.content` when `snippet` is null', () => {
    render(
      <ul>
        <SearchResultBlockRow
          row={makeRow({ snippet: null, content: 'literal content' })}
          isFocused={false}
          onClick={() => {}}
        />
      </ul>,
    )
    expect(screen.getByText('literal content')).toBeInTheDocument()
    // No mark elements when there's no snippet.
    expect(document.querySelector('mark')).toBeNull()
  })

  it('invokes onClick when the row is clicked', () => {
    const onClick = vi.fn()
    render(
      <ul>
        <SearchResultBlockRow row={makeRow()} isFocused={false} onClick={onClick} />
      </ul>,
    )
    fireEvent.click(screen.getByRole('option'))
    expect(onClick).toHaveBeenCalledOnce()
  })

  // PEND-73 Phase 3.U3 — the Enter/Space row-level keyDown handler was
  // dead code: the row has `tabIndex={-1}` so nothing in real usage
  // (including ARIA combobox patterns with aria-activedescendant) ever
  // focuses it, meaning the keydown event never fires through the row.
  // Enter/Space activation in production lives on the parent combobox
  // input, which dispatches to the active descendant by id. These two
  // tests exercised the removed handler via `fireEvent.keyDown` which
  // bypasses the focus prerequisite — green tests over dead code. The
  // click path below is the row's actual public contract.

  it('does not invoke onClick when `loading` is true', () => {
    const onClick = vi.fn()
    render(
      <ul>
        <SearchResultBlockRow row={makeRow()} isFocused={false} onClick={onClick} loading={true} />
      </ul>,
    )
    const option = screen.getByRole('option')
    expect(option).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(option)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('shows a Badge for page-typed rows', () => {
    render(
      <ul>
        <SearchResultBlockRow
          row={makeRow({ block_type: 'page' })}
          isFocused={false}
          onClick={() => {}}
        />
      </ul>,
    )
    expect(screen.getByText('page')).toBeInTheDocument()
  })

  it('shows a Badge for tag-typed rows', () => {
    render(
      <ul>
        <SearchResultBlockRow
          row={makeRow({ block_type: 'tag' })}
          isFocused={false}
          onClick={() => {}}
        />
      </ul>,
    )
    expect(screen.getByText('tag')).toBeInTheDocument()
  })

  it('threads the DOM `id` for `aria-activedescendant` plumbing', () => {
    render(
      <ul>
        <SearchResultBlockRow
          row={makeRow()}
          isFocused={false}
          onClick={() => {}}
          id="search-result-BLK1"
        />
      </ul>,
    )
    const option = screen.getByRole('option')
    expect(option).toHaveAttribute('id', 'search-result-BLK1')
  })
})
