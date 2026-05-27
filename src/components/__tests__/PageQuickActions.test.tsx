/**
 * Tests for PageQuickActions (PEND-68 Part A).
 *
 * Validates:
 *  - Each variant renders both the star and the delete IconButton.
 *  - Clicking the star toggles via `useStarredPages` (localStorage round-trip).
 *  - Clicking delete invokes the `onDeleteRequest` callback with
 *    (pageId, title) — the host owns the ConfirmDialog.
 *  - `showDelete={false}` hides the destructive button.
 *  - `deleting` disables the delete button.
 *  - `aria-pressed` reflects the starred state and switches on toggle.
 *  - axe a11y audit passes.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { PageQuickActions } from '../PageQuickActions'

beforeEach(() => {
  vi.clearAllMocks()
  // useStarredPages reads/writes localStorage['starred-pages']; keep
  // each test starting from an unstarred baseline.
  localStorage.removeItem('starred-pages')
})

describe('PageQuickActions', () => {
  for (const variant of ['header', 'journal', 'row'] as const) {
    it(`renders both star and delete buttons in the "${variant}" variant`, () => {
      render(
        <PageQuickActions
          pageId="PAGE_1"
          title="My Page"
          variant={variant}
          onDeleteRequest={() => {}}
        />,
      )

      expect(screen.getByRole('button', { name: /star this page/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /delete page/i })).toBeInTheDocument()
    })
  }

  it('marks the wrapper with data-variant for variant-keyed CSS hooks', () => {
    const { container } = render(
      <PageQuickActions
        pageId="PAGE_1"
        title="My Page"
        variant="journal"
        onDeleteRequest={() => {}}
      />,
    )

    const root = container.querySelector('[data-page-quick-actions]')
    expect(root).not.toBeNull()
    expect(root?.getAttribute('data-variant')).toBe('journal')
  })

  it('clicking the star toggles it on then off via useStarredPages', async () => {
    const user = userEvent.setup()

    render(
      <PageQuickActions
        pageId="PAGE_1"
        title="My Page"
        variant="header"
        onDeleteRequest={() => {}}
      />,
    )

    // Initially unstarred — aria-pressed="false" and label says "Star".
    const star = screen.getByRole('button', { name: /star this page/i })
    expect(star).toHaveAttribute('aria-pressed', 'false')

    await user.click(star)

    // After toggling, aria-pressed flips to "true" and the label updates.
    await waitFor(() => {
      const next = screen.getByRole('button', { name: /unstar this page/i })
      expect(next).toHaveAttribute('aria-pressed', 'true')
    })

    // localStorage round-trip — the page id landed in the persisted set.
    expect(JSON.parse(localStorage.getItem('starred-pages') ?? '[]')).toContain('PAGE_1')

    // Toggle back — should clear from localStorage.
    await user.click(screen.getByRole('button', { name: /unstar this page/i }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /star this page/i })).toHaveAttribute(
        'aria-pressed',
        'false',
      )
    })
    expect(JSON.parse(localStorage.getItem('starred-pages') ?? '[]')).not.toContain('PAGE_1')
  })

  it('clicking delete calls onDeleteRequest with (pageId, title) — host owns the dialog', async () => {
    const user = userEvent.setup()
    const onDeleteRequest = vi.fn()

    render(
      <PageQuickActions
        pageId="PAGE_1"
        title="My Page"
        variant="header"
        onDeleteRequest={onDeleteRequest}
      />,
    )

    await user.click(screen.getByRole('button', { name: /delete page/i }))

    expect(onDeleteRequest).toHaveBeenCalledTimes(1)
    expect(onDeleteRequest).toHaveBeenCalledWith('PAGE_1', 'My Page')
  })

  it('hides the delete button when showDelete={false}', () => {
    render(
      <PageQuickActions
        pageId="PAGE_1"
        title="My Page"
        variant="header"
        showDelete={false}
        onDeleteRequest={() => {}}
      />,
    )

    expect(screen.queryByRole('button', { name: /delete page/i })).not.toBeInTheDocument()
    // Star button is still rendered.
    expect(screen.getByRole('button', { name: /star this page/i })).toBeInTheDocument()
  })

  it('disables the delete button when deleting={true}', async () => {
    const user = userEvent.setup()
    const onDeleteRequest = vi.fn()

    render(
      <PageQuickActions
        pageId="PAGE_1"
        title="My Page"
        variant="journal"
        deleting
        onDeleteRequest={onDeleteRequest}
      />,
    )

    const deleteBtn = screen.getByRole('button', { name: /delete page/i })
    expect(deleteBtn).toBeDisabled()

    // A click on a disabled button should not invoke the callback.
    await user.click(deleteBtn)
    expect(onDeleteRequest).not.toHaveBeenCalled()
  })

  it('a11y: no axe violations', async () => {
    const { container } = render(
      <PageQuickActions
        pageId="PAGE_1"
        title="My Page"
        variant="header"
        onDeleteRequest={() => {}}
      />,
    )

    await waitFor(
      async () => {
        expect(await axe(container)).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })
})
