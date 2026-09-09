/**
 * Tests for the collapsible image (#4711), shared by the editor node view and
 * the static renderer.
 *
 * Covers: the toggle folds the image to a labelled chip and back; the state is
 * persisted so it survives a remount (the "reload" of the acceptance criteria);
 * two mounted copies of one src agree live — which is what makes collapse hold
 * as the roving editor moves a block between the node view and the static
 * renderer (invariant 4); the toggle does not activate the row it sits in; the
 * chip's label falls back from alt to filename and
 * is capped; folding a multi-megabyte `data:` image stores a bounded key
 * (#4864); a11y in both states.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { CollapsibleImage } from '@/components/rendering/CollapsibleImage'
import { t } from '@/lib/i18n'

afterEach(() => {
  localStorage.clear()
})

describe('CollapsibleImage', () => {
  it('renders the image expanded by default', () => {
    render(<CollapsibleImage src="/c.png" alt="a cat" />)
    expect(screen.getByTestId('image-rendered').getAttribute('src')).toBe('/c.png')
    expect(screen.queryByTestId('image-collapsed-label')).toBeNull()
    expect(screen.getByTestId('image-collapse-toggle').getAttribute('aria-expanded')).toBe('true')
  })

  it('collapses the image to a labelled chip and expands it again', async () => {
    const user = userEvent.setup()
    render(<CollapsibleImage src="/c.png" alt="a cat" />)

    await user.click(
      screen.getByRole('button', { name: t('editor.image.collapse', { name: 'a cat' }) }),
    )

    expect(screen.queryByTestId('image-rendered')).toBeNull()
    expect(screen.getByTestId('image-collapsed-label').textContent).toBe('a cat')
    expect(screen.getByTestId('image-collapse-toggle').getAttribute('aria-expanded')).toBe('false')

    await user.click(
      screen.getByRole('button', { name: t('editor.image.expand', { name: 'a cat' }) }),
    )

    expect(screen.getByTestId('image-rendered').getAttribute('src')).toBe('/c.png')
    expect(screen.queryByTestId('image-collapsed-label')).toBeNull()
  })

  it('keeps the collapsed state across a remount', async () => {
    const user = userEvent.setup()
    const first = render(<CollapsibleImage src="/c.png" alt="a cat" />)
    await user.click(screen.getByTestId('image-collapse-toggle'))
    first.unmount()

    render(<CollapsibleImage src="/c.png" alt="a cat" />)
    expect(screen.getByTestId('image-collapsed-label').textContent).toBe('a cat')
    expect(screen.queryByTestId('image-rendered')).toBeNull()
  })

  it('keeps the state per src — a different image stays expanded', async () => {
    const user = userEvent.setup()
    render(
      <>
        <CollapsibleImage src="/c.png" alt="a cat" />
        <CollapsibleImage src="/d.png" alt="a dog" />
      </>,
    )
    await user.click(
      screen.getByRole('button', { name: t('editor.image.collapse', { name: 'a cat' }) }),
    )

    expect(screen.getByTestId('image-collapsed-label').textContent).toBe('a cat')
    expect(screen.getByTestId('image-rendered').getAttribute('src')).toBe('/d.png')
  })

  it('folds every mounted copy of the same src at once (editor + static surfaces)', async () => {
    const user = userEvent.setup()
    render(
      <>
        <CollapsibleImage src="/c.png" alt="a cat" />
        <CollapsibleImage src="/c.png" alt="a cat" />
      </>,
    )
    expect(screen.getAllByTestId('image-rendered')).toHaveLength(2)

    await user.click(screen.getAllByTestId('image-collapse-toggle')[0] as HTMLElement)

    expect(screen.queryAllByTestId('image-rendered')).toHaveLength(0)
    expect(screen.getAllByTestId('image-collapsed-label')).toHaveLength(2)
  })

  it('labels the chip with the filename when alt is empty', async () => {
    const user = userEvent.setup()
    render(<CollapsibleImage src="/img/cat.png?v=2" alt="" />)
    await user.click(screen.getByTestId('image-collapse-toggle'))
    expect(screen.getByTestId('image-collapsed-label').textContent).toBe('cat.png')
  })

  it('caps a label with no short name (a data: src) rather than printing the whole src', async () => {
    const user = userEvent.setup()
    const src = `data:image/png;base64,${'A'.repeat(500)}`
    render(<CollapsibleImage src={src} alt="" />)
    await user.click(screen.getByTestId('image-collapse-toggle'))

    const label = screen.getByTestId('image-collapsed-label').textContent ?? ''
    expect(label).toHaveLength(41)
    expect(label.endsWith('…')).toBe(true)
  })

  // #4864 — the fold used to store the src verbatim, so one pasted screenshot
  // filled the ~5 MB origin quota and, because the resulting
  // `QuotaExceededError` is swallowed, silently stopped every OTHER preference
  // in the app from persisting.
  it('folds a multi-megabyte data: image without storing the src', async () => {
    const user = userEvent.setup()
    const src = `data:image/png;base64,${'A'.repeat(2_000_000)}`
    const { unmount } = render(<CollapsibleImage src={src} alt="a screenshot" />)

    await user.click(screen.getByTestId('image-collapse-toggle'))

    const stored = localStorage.getItem('image_collapsed') ?? ''
    expect(stored.length).toBeLessThan(100)

    // Still the same image on the way back: a bounded key is only useful if it
    // is the identity the next mount looks up.
    unmount()
    render(<CollapsibleImage src={src} alt="a screenshot" />)
    expect(screen.getByTestId('image-collapsed-label')).toBeInTheDocument()
    expect(screen.queryByTestId('image-rendered')).toBeNull()
  })

  it('does not activate the row it is rendered inside', async () => {
    // Agenda, Unfinished tasks and the outline all render block content
    // interactively inside a row that carries its own click and Enter/Space
    // handler (navigate to the block, or focus it for editing). Folding an
    // image must not do that too.
    const onRowClick = vi.fn()
    const onRowKeyDown = vi.fn()
    const user = userEvent.setup()
    render(
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- mirrors the real row, which is a li with handlers
      <li onClick={onRowClick} onKeyDown={onRowKeyDown}>
        <CollapsibleImage src="/c.png" alt="a cat" />
      </li>,
    )

    await user.click(screen.getByTestId('image-collapse-toggle'))
    expect(screen.getByTestId('image-collapsed-label')).toBeInTheDocument()
    expect(onRowClick).not.toHaveBeenCalled()

    screen.getByTestId('image-collapse-toggle').focus()
    await user.keyboard('{Enter}')
    expect(screen.getByTestId('image-rendered')).toBeInTheDocument()
    expect(onRowKeyDown).not.toHaveBeenCalled()
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it('has no a11y violations while expanded', async () => {
    const { container } = render(<CollapsibleImage src="/c.png" alt="a cat" />)
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })

  it('has no a11y violations while collapsed', async () => {
    const user = userEvent.setup()
    const { container } = render(<CollapsibleImage src="/c.png" alt="a cat" />)
    await user.click(screen.getByTestId('image-collapse-toggle'))
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
