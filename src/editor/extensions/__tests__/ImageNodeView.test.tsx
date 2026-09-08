/**
 * Tests for the editor's inline-image node view (#1434, #4711).
 *
 * The node view draws the image for the ONE block the roving editor is mounted
 * on (invariant 4), so it is one of the two surfaces the #4711 collapse toggle
 * has to reach — the static renderer is the other
 * (`RichContentRenderer/marks/__tests__/image.test.tsx`). The toggle's own
 * behaviour and persistence live in `CollapsibleImage.test.tsx`; this file pins
 * the wiring: attrs through to the image, and a working toggle in the node view.
 *
 * `@tiptap/react`'s NodeViewWrapper is stubbed to plain DOM — TipTap does not
 * render in the test environment (see components AGENTS.md).
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'

vi.mock('@tiptap/react', () => ({
  NodeViewWrapper: ({ children, ...rest }: { children?: React.ReactNode }) => (
    <span {...rest}>{children}</span>
  ),
}))

const { ImageNodeView } = await import('@/editor/extensions/ImageNodeView')

/** Minimal NodeViewProps stand-in carrying an image node's attrs. */
function makeProps(alt: string, src: string): React.ComponentProps<typeof ImageNodeView> {
  return { node: { attrs: { alt, src } } } as unknown as React.ComponentProps<typeof ImageNodeView>
}

afterEach(() => {
  localStorage.clear()
})

describe('ImageNodeView (#1434, #4711)', () => {
  it('renders the image with the src and alt from the node attrs', () => {
    render(<ImageNodeView {...makeProps('a cat', '/c.png')} />)
    const img = screen.getByTestId('image-rendered')
    expect(img.getAttribute('src')).toBe('/c.png')
    expect(img.getAttribute('alt')).toBe('a cat')
  })

  it('collapses the image from inside the node view', async () => {
    const user = userEvent.setup()
    render(<ImageNodeView {...makeProps('a cat', '/c.png')} />)

    await user.click(screen.getByTestId('image-collapse-toggle'))

    expect(screen.queryByTestId('image-rendered')).toBeNull()
    expect(screen.getByTestId('image-collapsed-label').textContent).toBe('a cat')
  })

  it('has no a11y violations', async () => {
    const { container } = render(<ImageNodeView {...makeProps('a cat', '/c.png')} />)
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
