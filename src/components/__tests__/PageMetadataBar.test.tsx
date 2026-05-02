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
import { makeBlock } from '../../__tests__/fixtures'
import { countWords, PageMetadataBar } from '../PageMetadataBar'

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
      const blocks = [
        makeBlock({ id: '1', content: 'hello world' }),
        makeBlock({ id: '2', content: 'foo bar baz' }),
      ]
      expect(countWords(blocks)).toBe(5)
    })

    it('returns 0 for empty blocks array', () => {
      expect(countWords([])).toBe(0)
    })

    it('handles blocks with null content', () => {
      const blocks = [
        makeBlock({ id: '1', content: null }),
        makeBlock({ id: '2', content: 'one two' }),
      ]
      expect(countWords(blocks)).toBe(2)
    })

    it('handles blocks with empty string content', () => {
      const blocks = [makeBlock({ id: '1', content: '' }), makeBlock({ id: '2', content: '  ' })]
      expect(countWords(blocks)).toBe(0)
    })

    it('handles blocks with extra whitespace', () => {
      const blocks = [makeBlock({ id: '1', content: '  hello   world  ' })]
      expect(countWords(blocks)).toBe(2)
    })
  })

  describe('component', () => {
    it('is collapsed by default and shows toggle button', () => {
      render(<PageMetadataBar blocks={[]} pageId={TEST_ULID} />)

      const button = screen.getByRole('button', { name: /(expand|collapse) info/i })
      expect(button).toBeInTheDocument()
      expect(button).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByTestId('metadata-content')).not.toBeInTheDocument()
    })

    it('expands on click and shows metadata', async () => {
      const user = userEvent.setup()
      const blocks = [
        makeBlock({ id: '1', content: 'hello world' }),
        makeBlock({ id: '2', content: 'foo bar baz' }),
      ]

      render(<PageMetadataBar blocks={blocks} pageId={TEST_ULID} />)

      const button = screen.getByRole('button', { name: /(expand|collapse) info/i })
      await user.click(button)

      expect(button).toHaveAttribute('aria-expanded', 'true')
      const content = screen.getByTestId('metadata-content')
      expect(content).toBeInTheDocument()
    })

    it('renders correct word count when expanded', async () => {
      const user = userEvent.setup()
      const blocks = [
        makeBlock({ id: '1', content: 'one two three' }),
        makeBlock({ id: '2', content: 'four five' }),
      ]

      render(<PageMetadataBar blocks={blocks} pageId={TEST_ULID} />)

      await user.click(screen.getByRole('button', { name: /(expand|collapse) info/i }))

      const content = screen.getByTestId('metadata-content')
      expect(content.textContent).toContain('5 words')
    })

    it('renders singular word count', async () => {
      const user = userEvent.setup()
      const blocks = [makeBlock({ id: '1', content: 'hello' })]

      render(<PageMetadataBar blocks={blocks} pageId={TEST_ULID} />)

      await user.click(screen.getByRole('button', { name: /(expand|collapse) info/i }))

      const content = screen.getByTestId('metadata-content')
      expect(content.textContent).toContain('1 word')
    })

    it('renders correct block count when expanded', async () => {
      const user = userEvent.setup()
      const blocks = [
        makeBlock({ id: '1', content: 'a' }),
        makeBlock({ id: '2', content: 'b' }),
        makeBlock({ id: '3', content: 'c' }),
      ]

      render(<PageMetadataBar blocks={blocks} pageId={TEST_ULID} />)

      await user.click(screen.getByRole('button', { name: /(expand|collapse) info/i }))

      const content = screen.getByTestId('metadata-content')
      expect(content.textContent).toContain('3 blocks')
    })

    it('renders singular block count', async () => {
      const user = userEvent.setup()
      const blocks = [makeBlock({ id: '1', content: 'hello' })]

      render(<PageMetadataBar blocks={blocks} pageId={TEST_ULID} />)

      await user.click(screen.getByRole('button', { name: /(expand|collapse) info/i }))

      const content = screen.getByTestId('metadata-content')
      expect(content.textContent).toContain('1 block')
      // Ensure it doesn't say "1 blocks"
      expect(content.textContent).not.toMatch(/1 blocks/)
    })

    it('renders created date from ULID', async () => {
      const user = userEvent.setup()

      render(
        <PageMetadataBar blocks={[makeBlock({ id: '1', content: 'hi' })]} pageId={TEST_ULID} />,
      )

      await user.click(screen.getByRole('button', { name: /(expand|collapse) info/i }))

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

      await user.click(screen.getByRole('button', { name: /(expand|collapse) info/i }))

      const content = screen.getByTestId('metadata-content')
      expect(content.textContent).toContain('0 words')
      expect(content.textContent).toContain('0 blocks')
    })

    it('handles blocks with null/empty content when expanded', async () => {
      const user = userEvent.setup()
      const blocks = [
        makeBlock({ id: '1', content: null }),
        makeBlock({ id: '2', content: '' }),
        makeBlock({ id: '3', content: 'hello' }),
      ]

      render(<PageMetadataBar blocks={blocks} pageId={TEST_ULID} />)

      await user.click(screen.getByRole('button', { name: /(expand|collapse) info/i }))

      const content = screen.getByTestId('metadata-content')
      expect(content.textContent).toContain('1 word')
      expect(content.textContent).toContain('3 blocks')
    })

    it('does not render created date for invalid ULID', async () => {
      const user = userEvent.setup()

      render(<PageMetadataBar blocks={[makeBlock({ id: '1', content: 'hi' })]} pageId="short" />)

      await user.click(screen.getByRole('button', { name: /(expand|collapse) info/i }))

      const content = screen.getByTestId('metadata-content')
      expect(content.textContent).not.toContain('Created')
    })

    it('collapses again on second click', async () => {
      const user = userEvent.setup()

      render(<PageMetadataBar blocks={[]} pageId={TEST_ULID} />)

      const button = screen.getByRole('button', { name: /(expand|collapse) info/i })

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
      const blocks = [makeBlock({ id: '1', content: 'hello world' })]
      const { container } = render(<PageMetadataBar blocks={blocks} pageId={TEST_ULID} />)

      await user.click(screen.getByRole('button', { name: /(expand|collapse) info/i }))

      await waitFor(async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      })
    })
  })
})
