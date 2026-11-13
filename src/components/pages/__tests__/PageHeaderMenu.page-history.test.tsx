/**
 * The page menu's *Page history* row (#6535): offered only when the header
 * passes `onOpenHistory`, and sits with Undo and Redo.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import type { PageHeaderMenuProps } from '@/components/pages/PageHeaderMenu'
import { PageHeaderMenu } from '@/components/pages/PageHeaderMenu'
import { t } from '@/lib/i18n'

const noop = () => {}

const props: PageHeaderMenuProps = {
  canRedo: false,
  kebabOpen: true,
  isTemplate: false,
  isJournalTemplate: false,
  onUndo: noop,
  onRedo: noop,
  onOpenOutline: noop,
  onShowInGraph: noop,
  onInsertEmoji: noop,
  onKebabOpenChange: noop,
  onAddAlias: noop,
  onAddTag: noop,
  onAddProperty: noop,
  onToggleTemplate: noop,
  onToggleJournalTemplate: noop,
  onExport: noop,
  onCopyAppLink: noop,
  onDeleteRequest: noop,
}

function openMenu(overrides: Partial<PageHeaderMenuProps> = {}) {
  const view = render(<PageHeaderMenu {...props} {...overrides} />)
  return { ...view, menu: screen.getByRole('menu', { name: t('pageHeader.pageActions') }) }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PageHeaderMenu — Page history', () => {
  it('opens the page history when the row is chosen', async () => {
    const user = userEvent.setup()
    const onOpenHistory = vi.fn()
    const { menu } = openMenu({ onOpenHistory })

    await user.click(within(menu).getByRole('menuitem', { name: t('pageHeader.pageHistory') }))

    expect(onOpenHistory).toHaveBeenCalledOnce()
  })

  it('is reached by ArrowDown straight after Undo', async () => {
    const user = userEvent.setup()
    const { menu } = openMenu({ onOpenHistory: vi.fn() })
    // The name carries the shortcut hint after the label.
    const undo = within(menu).getByRole('menuitem', {
      name: new RegExp(`^${t('pageHeader.undoAction')}`),
    })
    await waitFor(() => {
      expect(
        within(menu).getByRole('menuitem', { name: t('pageHeader.copyAppLink') }),
      ).toHaveFocus()
    })
    await user.keyboard('{ArrowDown}')
    expect(undo).toHaveFocus()

    await user.keyboard('{ArrowDown}')

    expect(within(menu).getByRole('menuitem', { name: t('pageHeader.pageHistory') })).toHaveFocus()
  })

  it('is not offered without a handler', () => {
    const { menu } = openMenu()

    expect(
      within(menu).queryByRole('menuitem', { name: t('pageHeader.pageHistory') }),
    ).not.toBeInTheDocument()
  })

  it('has no a11y violations with the row shown', async () => {
    const { container } = openMenu({ onOpenHistory: vi.fn() })

    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
