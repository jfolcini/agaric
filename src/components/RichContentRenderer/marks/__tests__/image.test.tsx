/**
 * Tests for the static image renderer (#1434).
 *
 * The renderer must draw an `<img src alt>` and, on a load error, fall back to a
 * labelled placeholder (showing the alt text / URL) instead of a context-free
 * broken-image glyph.
 */

import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { ImageNode } from '../../../../editor/types'
import { renderImage } from '../image'

function imageNode(alt: string, src: string): ImageNode {
  return { type: 'image', attrs: { alt, src } }
}

describe('renderImage (#1434)', () => {
  it('renders an `<img>` carrying the src and alt', () => {
    const { container } = render(<>{renderImage(imageNode('a cat', 'https://x.com/c.png'), 'k')}</>)
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('https://x.com/c.png')
    expect(img?.getAttribute('alt')).toBe('a cat')
  })

  it('renders an `<img>` with empty alt for `![](url)`', () => {
    const { container } = render(<>{renderImage(imageNode('', 'c.png'), 'k')}</>)
    const img = container.querySelector('img')
    expect(img?.getAttribute('alt')).toBe('')
    expect(img?.getAttribute('src')).toBe('c.png')
  })

  it('falls back to a labelled placeholder (alt text) on image load error', () => {
    const { container, getByTestId } = render(
      <>{renderImage(imageNode('a cat', 'https://x.com/missing.png'), 'k')}</>,
    )
    const img = container.querySelector('img') as HTMLImageElement
    fireEvent.error(img)

    // The <img> is replaced by the broken-image placeholder showing the alt.
    expect(container.querySelector('img')).toBeNull()
    const broken = getByTestId('image-broken')
    expect(broken.textContent).toContain('a cat')
    expect(broken.getAttribute('title')).toBe('https://x.com/missing.png')
  })

  it('falls back to the URL when alt is empty on load error', () => {
    const { container, getByTestId } = render(
      <>{renderImage(imageNode('', 'https://x.com/missing.png'), 'k')}</>,
    )
    fireEvent.error(container.querySelector('img') as HTMLImageElement)
    expect(getByTestId('image-broken').textContent).toContain('https://x.com/missing.png')
  })
})
