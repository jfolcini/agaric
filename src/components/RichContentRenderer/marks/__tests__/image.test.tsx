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
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { renderImage } from '@/components/RichContentRenderer/marks/image'
import type { ImageNode } from '@/editor/types'

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

  // #4711: the static renderer draws every image that is not on the focused
  // block (invariant 4), so collapse has to reach it too — not just the node
  // view. The toggle's own behaviour is covered in `CollapsibleImage.test.tsx`.
  it('carries the collapse toggle, and collapsing replaces the `<img>` with the chip', async () => {
    const user = userEvent.setup()
    const { container, getByTestId, queryByTestId } = render(
      <>{renderImage(imageNode('a cat', '/c.png'), 'k')}</>,
    )

    await user.click(getByTestId('image-collapse-toggle'))

    expect(container.querySelector('img')).toBeNull()
    expect(getByTestId('image-collapsed-label').textContent).toBe('a cat')
    expect(queryByTestId('image-rendered')).toBeNull()
  })
})
