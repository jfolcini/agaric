/**
 * Tests for at-rest static rendering of bullet lists (#1512) and
 * blockquotes/callouts containing non-paragraph children (#1534).
 *
 * Both bugs silently dropped content: `renderBlock` had no `bulletList` case
 * (fell through to `default: return null`), and `renderBlockquoteChild` only
 * handled `paragraph`/`heading`, returning null for nested lists/code/etc.
 */

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { parse } from '../../../../editor/markdown-serializer'
import type { BlockLevelNode } from '../../../../editor/types'
import type { RenderContext } from '../../context'
import { renderBlock } from '../block'

const ctx: RenderContext = {}

/** Parse markdown and return the first top-level block. */
function firstBlock(markdown: string): BlockLevelNode {
  const doc = parse(markdown)
  const block = doc.content?.[0]
  if (!block) throw new Error(`no block parsed from: ${markdown}`)
  return block as BlockLevelNode
}

describe('renderBlock — bulletList (#1512)', () => {
  it('renders a bulletList as a <ul> with one <li> per item', () => {
    const block = firstBlock('- first\n- second')
    expect(block.type).toBe('bulletList')

    const { container } = render(<>{renderBlock(block, 'k', ctx)}</>)

    const ul = container.querySelector('ul')
    expect(ul).not.toBeNull()
    expect(ul?.className).toContain('list-disc')

    const items = container.querySelectorAll('li')
    expect(items).toHaveLength(2)
    expect(items[0]?.textContent).toContain('first')
    expect(items[1]?.textContent).toContain('second')
  })
})

describe('renderBlock — blockquote with non-paragraph children (#1534)', () => {
  it('renders a nested bullet list inside a blockquote (not empty)', () => {
    const block = firstBlock('> - alpha\n> - beta')
    expect(block.type).toBe('blockquote')

    const { container } = render(<>{renderBlock(block, 'k', ctx)}</>)

    const bq = container.querySelector('blockquote')
    expect(bq).not.toBeNull()

    // The nested list must survive rather than being silently dropped.
    const ul = container.querySelector('blockquote ul')
    expect(ul).not.toBeNull()

    const items = container.querySelectorAll('blockquote li')
    expect(items).toHaveLength(2)
    expect(bq?.textContent).toContain('alpha')
    expect(bq?.textContent).toContain('beta')
  })
})
