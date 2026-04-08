/**
 * Tests for PageMetadataBar component.
 *
 * Validates:
 *  - Renders word count correctly
 *  - Renders block count
 *  - Renders created date from ULID
 *  - Handles empty blocks array
 *  - Handles blocks with null/empty content
 *  - axe(container) a11y audit
 *  - Toggle collapse/expand
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import type { FlatBlock } from '../../lib/tree-utils'
import { countWords, PageMetadataBar } from '../PageMetadataBar'

function makeBlock(id: string, content: string | null, parentId: string | null = null): FlatBlock {
  return {
    id,
    block_type: 'content',
    content,
    parent_id: parentId,
    position: 0,
    deleted_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    depth: 0,
  }
}

// A valid ULID encoding 2026-04-09 timestamp.
// ULID timestamp = first 10 chars of Crockford base32.
// 2026-04-09T00:00:00.000Z = 1775692800000 ms
// Encode 1775692800000 in Crockford base32 (10 chars):
//   1775692800000 / 32^9 = ...
// For test simplicity we use a pre-computed ULID prefix.
// Let's use a known ULID: 01JRK00000 encodes a specific timestamp.
// Instead, we'll just use a ULID that decodes to a known date.
// The ULID "01ARZ3NDEKTSV4RRFFQ69G5FAV" decodes to 2016-07-30T23:54:10.259Z
const TEST_ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

describe('PageMetadataBar', () => {
  describe('countWords', () => {
    it('counts words across multiple blocks', () => {
      const blocks = [makeBlock('1', 'hello world'), makeBlock('2', 'foo bar baz')]
      expect(countWords(blocks)).toBe(5)
    })

    it('returns 0 for empty blocks array', () => {
      expect(countWords([])).toBe(0)
    })

    it('handles blocks with null content', () => {
      const blocks = [makeBlock('1', null), makeBlock('2', 'one two')]
      expect(countWords(blocks)).toBe(2)
    })

    it('handles blocks with empty string content', () => {
      const blocks = [makeBlock('1', ''), makeBlock('2', '  ')]
      expect(countWords(blocks)).toBe(0)
    })

    it('handles blocks with extra whitespace', () => {
      const blocks = [makeBlock('1', '  hello   world  ')]
      expect(countWords(blocks)).toBe(2)
    })
  })

  describe('component', () => {
    it('is collapsed by default and shows toggle button', () => {
      render(<PageMetadataBar blocks={[]} pageId={TEST_ULID} />)

      const button = screen.getByRole('button', { name: /toggle page metadata/i })
      expect(button).toBeInTheDocument()
      expect(button).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByTestId('metadata-content')).not.toBeInTheDocument()
    })

    it('expands on click and shows metadata', async () => {
      const user = userEvent.setup()
      const blocks = [makeBlock('1', 'hello world'), makeBlock('2', 'foo bar baz')]

      render(<PageMetadataBar blocks={blocks} pageId={TEST_ULID} />)

      const button = screen.getByRole('button', { name: /toggle page metadata/i })
      await user.click(button)

      expect(button).toHaveAttribute('aria-expanded', 'true')
      const content = screen.getByTestId('metadata-content')
      expect(content).toBeInTheDocument()
    })

    it('renders correct word count when expanded', async () => {
      const user = userEvent.setup()
      const blocks = [makeBlock('1', 'one two three'), makeBlock('2', 'four five')]

      render(<PageMetadataBar blocks={blocks} pageId={TEST_ULID} />)

      await user.click(screen.getByRole('button', { name: /toggle page metadata/i }))

      const content = screen.getByTestId('metadata-content')
      expect(content.textContent).toContain('5 words')
    })

    it('renders singular word count', async () => {
      const user = userEvent.setup()
      const blocks = [makeBlock('1', 'hello')]

      render(<PageMetadataBar blocks={blocks} pageId={TEST_ULID} />)

      await user.click(screen.getByRole('button', { name: /toggle page metadata/i }))

      const content = screen.getByTestId('metadata-content')
      expect(content.textContent).toContain('1 word')
    })

    it('renders correct block count when expanded', async () => {
      const user = userEvent.setup()
      const blocks = [makeBlock('1', 'a'), makeBlock('2', 'b'), makeBlock('3', 'c')]

      render(<PageMetadataBar blocks={blocks} pageId={TEST_ULID} />)

      await user.click(screen.getByRole('button', { name: /toggle page metadata/i }))

      const content = screen.getByTestId('metadata-content')
      expect(content.textContent).toContain('3 blocks')
    })

    it('renders singular block count', async () => {
      const user = userEvent.setup()
      const blocks = [makeBlock('1', 'hello')]

      render(<PageMetadataBar blocks={blocks} pageId={TEST_ULID} />)

      await user.click(screen.getByRole('button', { name: /toggle page metadata/i }))

      const content = screen.getByTestId('metadata-content')
      expect(content.textContent).toContain('1 block')
      // Ensure it doesn't say "1 blocks"
      expect(content.textContent).not.toMatch(/1 blocks/)
    })

    it('renders created date from ULID', async () => {
      const user = userEvent.setup()

      render(<PageMetadataBar blocks={[makeBlock('1', 'hi')]} pageId={TEST_ULID} />)

      await user.click(screen.getByRole('button', { name: /toggle page metadata/i }))

      const content = screen.getByTestId('metadata-content')
      // The ULID 01ARZ3NDEK... decodes to 2016-07-30T23:54:10.259Z (UTC).
      // Depending on the test environment's timezone, toLocaleDateString may
      // render Jul 30 or Jul 31. Assert the year and "Created" prefix.
      expect(content.textContent).toContain('Created')
      expect(content.textContent).toMatch(/Jul\s+3[01],\s+2016/)
    })

    it('handles empty blocks array when expanded', async () => {
      const user = userEvent.setup()

      render(<PageMetadataBar blocks={[]} pageId={TEST_ULID} />)

      await user.click(screen.getByRole('button', { name: /toggle page metadata/i }))

      const content = screen.getByTestId('metadata-content')
      expect(content.textContent).toContain('0 words')
      expect(content.textContent).toContain('0 blocks')
    })

    it('handles blocks with null/empty content when expanded', async () => {
      const user = userEvent.setup()
      const blocks = [makeBlock('1', null), makeBlock('2', ''), makeBlock('3', 'hello')]

      render(<PageMetadataBar blocks={blocks} pageId={TEST_ULID} />)

      await user.click(screen.getByRole('button', { name: /toggle page metadata/i }))

      const content = screen.getByTestId('metadata-content')
      expect(content.textContent).toContain('1 word')
      expect(content.textContent).toContain('3 blocks')
    })

    it('does not render created date for invalid ULID', async () => {
      const user = userEvent.setup()

      render(<PageMetadataBar blocks={[makeBlock('1', 'hi')]} pageId="short" />)

      await user.click(screen.getByRole('button', { name: /toggle page metadata/i }))

      const content = screen.getByTestId('metadata-content')
      expect(content.textContent).not.toContain('Created')
    })

    it('collapses again on second click', async () => {
      const user = userEvent.setup()

      render(<PageMetadataBar blocks={[]} pageId={TEST_ULID} />)

      const button = screen.getByRole('button', { name: /toggle page metadata/i })

      // Expand
      await user.click(button)
      expect(screen.getByTestId('metadata-content')).toBeInTheDocument()

      // Collapse
      await user.click(button)
      expect(screen.queryByTestId('metadata-content')).not.toBeInTheDocument()
      expect(button).toHaveAttribute('aria-expanded', 'false')
    })

    it('has no a11y violations when collapsed', async () => {
      const { container } = render(<PageMetadataBar blocks={[]} pageId={TEST_ULID} />)

      await waitFor(async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      })
    })

    it('has no a11y violations when expanded', async () => {
      const user = userEvent.setup()
      const blocks = [makeBlock('1', 'hello world')]
      const { container } = render(<PageMetadataBar blocks={blocks} pageId={TEST_ULID} />)

      await user.click(screen.getByRole('button', { name: /toggle page metadata/i }))

      await waitFor(async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      })
    })
  })
})
