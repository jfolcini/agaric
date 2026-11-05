/**
 * A linked image (`[![alt](src)](href)`, a README badge) renders as an image
 * that opens its link (#6342), and a blocked-scheme href leaves the bare image.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'

const mockOpenUrl = vi.hoisted(() => vi.fn(() => Promise.resolve(true)))
vi.mock('@/lib/open-url', () => ({ openUrl: mockOpenUrl }))

import type { RenderContext } from '@/components/RichContentRenderer/context'
import { renderImage } from '@/components/RichContentRenderer/marks/image'
import type { ImageNode } from '@/editor/types'

function linkedImage(href: string, src = '/badge.svg'): ImageNode {
  return {
    type: 'image',
    attrs: { alt: 'CI', src },
    marks: [{ type: 'link', attrs: { href } }],
  }
}

beforeEach(() => mockOpenUrl.mockClear())
afterEach(() => localStorage.clear())

describe('renderImage — an image inside a link (#6342)', () => {
  it.each([true, false])('opens its link on click (interactive: %s)', async (interactive) => {
    const ctx: RenderContext = { interactive }
    render(<>{renderImage(linkedImage('https://x.com/actions'), 'k', ctx)}</>)

    const link = screen.getByRole('link', { name: /CI/ })
    expect(link.querySelector('img[alt="CI"]')).not.toBeNull()
    await userEvent.click(link)
    expect(mockOpenUrl).toHaveBeenLastCalledWith('https://x.com/actions')
  })

  it('has no fold toggle inside the link', () => {
    render(<>{renderImage(linkedImage('https://x.com/actions'), 'k', { interactive: true })}</>)
    expect(screen.queryByTestId('image-collapse-toggle')).toBeNull()
  })

  it('loads a withheld external badge without opening its link', async () => {
    const user = userEvent.setup()
    const node = linkedImage('https://x.com/actions', 'https://img.x.com/badge.svg')
    render(<>{renderImage(node, 'k', { interactive: true })}</>)

    await user.click(screen.getByTestId('image-load-button'))
    expect(screen.getByTestId('image-rendered')).toHaveAttribute(
      'src',
      'https://img.x.com/badge.svg',
    )
    expect(mockOpenUrl).not.toHaveBeenCalled()
  })

  it('loads a withheld badge from the keyboard without opening its link', async () => {
    const user = userEvent.setup()
    const node = linkedImage('https://x.com/actions', 'https://img.x.com/badge.svg')
    render(<>{renderImage(node, 'k', { interactive: true })}</>)

    screen.getByTestId('image-load-button').focus()
    await user.keyboard('{Enter}')
    expect(screen.getByTestId('image-rendered')).toBeInTheDocument()
    expect(mockOpenUrl).not.toHaveBeenCalled()
  })

  it('renders a blocked-scheme link as the bare image', () => {
    render(<>{renderImage(linkedImage('javascript:alert(1)'), 'k', { interactive: true })}</>)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByRole('img', { name: 'CI' })).toBeInTheDocument()
  })

  it('has no axe violations', async () => {
    const { container } = render(
      <p>{renderImage(linkedImage('https://x.com/actions'), 'k', { interactive: true })}</p>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
