import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { InlinePropertyChip } from '@/components/properties/InlinePropertyChip'
import { t } from '@/lib/i18n'
import { keyFor, useResolveStore } from '@/stores/resolve'

const TARGET = '00000000000000000000PAGE02'

function cacheTitle(title: string) {
  useResolveStore.setState({
    cache: new Map([[keyFor(null, TARGET), { title, deleted: false, resolved: true }]]),
    version: useResolveStore.getState().version + 1,
  })
}

function renderChip(
  property: { key: string; value: string; kind?: 'ref' | 'boolean' },
  handlers: Partial<{
    onEditProp: (prop: { key: string; value: string }) => void
    onNavigate: (id: string) => void
    onShowProperties: (blockId: string) => void
  }> = {},
) {
  return render(
    <InlinePropertyChip
      blockId="BLOCK_1"
      property={property}
      onEditProp={handlers.onEditProp ?? vi.fn()}
      onEditKey={vi.fn()}
      onNavigate={handlers.onNavigate}
      onShowProperties={handlers.onShowProperties}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  useResolveStore.setState({ cache: new Map(), version: 0 })
})

describe('InlinePropertyChip', () => {
  it('opens the chip editor from a text value', async () => {
    const user = userEvent.setup()
    const onEditProp = vi.fn()
    renderChip({ key: 'effort', value: '2h' }, { onEditProp })

    await user.click(screen.getByRole('button', { name: 'Effort: 2h' }))

    expect(onEditProp).toHaveBeenCalledExactlyOnceWith({ key: 'effort', value: '2h' })
  })

  describe('ref value', () => {
    it("shows the target's title and follows a rename", () => {
      cacheTitle('Quick Notes')
      renderChip({ key: 'owner', value: TARGET, kind: 'ref' }, { onNavigate: vi.fn() })
      expect(
        screen.getByRole('button', { name: t('property.openRefTarget', { title: 'Quick Notes' }) }),
      ).toHaveTextContent('Quick Notes')

      act(() => cacheTitle('Inbox'))

      expect(
        screen.getByRole('button', { name: t('property.openRefTarget', { title: 'Inbox' }) }),
      ).toHaveTextContent('Inbox')
      expect(screen.queryByText('Quick Notes')).not.toBeInTheDocument()
    })

    it('opens its target on click', async () => {
      const user = userEvent.setup()
      const onNavigate = vi.fn()
      const onEditProp = vi.fn()
      cacheTitle('Quick Notes')
      renderChip({ key: 'owner', value: TARGET, kind: 'ref' }, { onNavigate, onEditProp })

      await user.click(
        screen.getByRole('button', { name: t('property.openRefTarget', { title: 'Quick Notes' }) }),
      )

      expect(onNavigate).toHaveBeenCalledExactlyOnceWith(TARGET)
      expect(onEditProp).not.toHaveBeenCalled()
    })

    it('has no a11y violations', async () => {
      cacheTitle('Quick Notes')
      const { container } = renderChip(
        { key: 'owner', value: TARGET, kind: 'ref' },
        { onNavigate: vi.fn() },
      )
      await waitFor(async () => {
        expect(await axe(container)).toHaveNoViolations()
      })
    })
  })

  describe('boolean value', () => {
    it.each([
      ['true', 'property.booleanTrue'],
      ['false', 'property.booleanFalse'],
    ])('says %s in words', (value, label) => {
      renderChip({ key: 'billable', value, kind: 'boolean' })
      expect(screen.getByRole('group', { name: `Billable: ${t(label)}` })).toHaveTextContent(
        `Billable:${t(label)}`,
      )
    })

    it("opens the block's property drawer on click, not the text editor", async () => {
      const user = userEvent.setup()
      const onShowProperties = vi.fn()
      const onEditProp = vi.fn()
      renderChip(
        { key: 'billable', value: 'true', kind: 'boolean' },
        { onShowProperties, onEditProp },
      )

      await user.click(
        screen.getByRole('button', { name: `Billable: ${t('property.booleanTrue')}` }),
      )

      expect(onShowProperties).toHaveBeenCalledExactlyOnceWith('BLOCK_1')
      expect(onEditProp).not.toHaveBeenCalled()
    })

    it('has no a11y violations', async () => {
      const { container } = renderChip(
        { key: 'billable', value: 'false', kind: 'boolean' },
        { onShowProperties: vi.fn() },
      )
      await waitFor(async () => {
        expect(await axe(container)).toHaveNoViolations()
      })
    })
  })
})
