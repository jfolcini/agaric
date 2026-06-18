/**
 * Tests for the static image renderer (#1434, #1492).
 *
 * The renderer delegates to the shared `GatedImage`. For LOCAL srcs (relative /
 * `data:`) it must draw an `<img src alt>` and, on a load error, fall back to a
 * labelled placeholder (#1434). The #1492 external-image gating is covered in
 * `GatedImage.test.tsx`; here we assert local images are never gated and that
 * the static-render wiring passes src/alt through.
 */

import { fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { ImageNode } from '../../../../editor/types'
import { renderImage } from '../image'

function imageNode(alt: string, src: string): ImageNode {
  return { type: 'image', attrs: { alt, src } }
}

afterEach(() => {
  localStorage.clear()
})

describe('renderImage (#1434/#1492)', () => {
  it('renders an `<img>` carrying the src and alt for a local src', () => {
    const { container } = render(<>{renderImage(imageNode('a cat', '/c.png'), 'k')}</>)
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('/c.png')
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
      <>{renderImage(imageNode('a cat', '/missing.png'), 'k')}</>,
    )
    const img = container.querySelector('img') as HTMLImageElement
    fireEvent.error(img)

    // The <img> is replaced by the broken-image placeholder showing the alt.
    expect(container.querySelector('img')).toBeNull()
    const broken = getByTestId('image-broken')
    expect(broken.textContent).toContain('a cat')
    expect(broken.getAttribute('title')).toBe('/missing.png')
  })

  it('falls back to the URL when alt is empty on load error', () => {
    const { container, getByTestId } = render(
      <>{renderImage(imageNode('', '/missing.png'), 'k')}</>,
    )
    fireEvent.error(container.querySelector('img') as HTMLImageElement)
    expect(getByTestId('image-broken').textContent).toContain('/missing.png')
  })
})
