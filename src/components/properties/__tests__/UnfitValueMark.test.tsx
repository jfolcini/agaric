/**
 * #6206 — the mark on a value that doesn't fit its key: a button that opens
 * Settings › Properties on the key's values that don't fit.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { UnfitValueMark } from '@/components/properties/UnfitValueMark'
import { t } from '@/lib/i18n'
import { useNavigationStore } from '@/stores/navigation'

const LABEL = t('property.unfitReview', { key: 'Project', value: 'beta' })

beforeEach(() => {
  vi.clearAllMocks()
  useNavigationStore.setState({
    currentView: 'journal',
    pendingSettingsTab: null,
    pendingPropertyReview: null,
  })
})

function expectSettingsOpenedOnProject(): void {
  const navigation = useNavigationStore.getState()
  expect(navigation.currentView).toBe('settings')
  expect(navigation.pendingSettingsTab).toBe('properties')
  expect(navigation.pendingPropertyReview).toBe('project')
}

describe('UnfitValueMark', () => {
  it("opens Settings › Properties on the key's values on a click", async () => {
    const user = userEvent.setup()
    render(<UnfitValueMark propKey="project" value="beta" />)

    await user.click(screen.getByRole('button', { name: LABEL }))

    expectSettingsOpenedOnProject()
  })

  it('opens them from the keyboard, with Tab and Enter', async () => {
    const user = userEvent.setup()
    render(<UnfitValueMark propKey="project" value="beta" />)

    await user.tab()
    expect(screen.getByRole('button', { name: LABEL })).toHaveFocus()
    await user.keyboard('{Enter}')

    expectSettingsOpenedOnProject()
  })

  it('keeps its click from the block around it', async () => {
    const user = userEvent.setup()
    const onBlockClick = vi.fn()
    render(
      // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- stands in for the static block's click-to-focus surface
      <div onClick={onBlockClick}>
        <button type="button">content</button>
        <UnfitValueMark propKey="project" value="beta" />
      </div>,
    )

    await user.click(screen.getByRole('button', { name: 'content' }))
    expect(onBlockClick).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: LABEL }))
    expect(onBlockClick).toHaveBeenCalledTimes(1)
  })

  it('has no a11y violations', async () => {
    const { container } = render(<UnfitValueMark propKey="project" value="beta" />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
