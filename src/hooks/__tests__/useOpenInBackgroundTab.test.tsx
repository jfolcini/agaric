/**
 * A link chip's new-tab paths, through the tabs store: a middle click or a
 * Ctrl/Cmd+click opens the target behind the active tab, and a click anywhere
 * else is left to the element under it.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { delegatedLinkClickProps, useOpenLinkInNewTab } from '@/hooks/useOpenInBackgroundTab'
import type { NavigateToPageFn } from '@/lib/block-events'
import { useNavigationStore } from '@/stores/navigation'
import { useTabsStore } from '@/stores/tabs'

/** Stands in for `useBlockNavigateToLink`: a page link opens its page, a block ref its block's page. */
function navigate(linkId: string, openPage: NavigateToPageFn): Promise<void> {
  if (linkId === 'REF') openPage('REF_PAGE', 'Ref page', 'REF')
  else openPage(linkId, 'Linked page')
  return Promise.resolve()
}

const onChipClick = vi.fn()
const onTextClick = vi.fn()

function Links(): React.ReactElement {
  const open = useOpenLinkInNewTab(navigate)
  return (
    <div {...(open ? delegatedLinkClickProps(open) : {})}>
      <button type="button" onClick={onTextClick}>
        block text
      </button>
      <button type="button" data-type="block-link" data-id="LINKED" onClick={onChipClick}>
        page link
      </button>
      <button type="button" data-type="block-ref" data-id="REF" onClick={onChipClick}>
        block ref
      </button>
    </div>
  )
}

function activeTop() {
  const { tabs, activeTabIndex } = useTabsStore.getState()
  return tabs[activeTabIndex]?.pageStack.at(-1)
}

beforeEach(() => {
  vi.clearAllMocks()
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [{ pageId: 'CUR', title: 'Current' }], label: 'Current' }],
    activeTabIndex: 0,
    tabsBySpace: {},
    activeTabIndexBySpace: {},
  })
  useNavigationStore.setState({ currentView: 'page-editor', selectedBlockId: null })
})

describe('link chips and new tabs', () => {
  it.each([{ ctrlKey: true }, { metaKey: true }])(
    'a click with %o on a page link opens it behind the active tab, without the chip’s own click',
    (modifier) => {
      render(<Links />)

      expect(fireEvent.click(screen.getByText('page link'), modifier)).toBe(false)

      expect(useTabsStore.getState().tabs).toHaveLength(2)
      expect(useTabsStore.getState().activeTabIndex).toBe(0)
      expect(activeTop()).toEqual({ pageId: 'CUR', title: 'Current' })
      expect(useTabsStore.getState().tabs[1]?.pageStack).toEqual([
        { pageId: 'LINKED', title: 'Linked page' },
      ])
      expect(useNavigationStore.getState().currentView).toBe('page-editor')
      expect(onChipClick).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['a Ctrl+click', (chip: HTMLElement) => fireEvent.click(chip, { ctrlKey: true })],
    [
      'a middle click',
      (chip: HTMLElement) => userEvent.setup().pointer({ keys: '[MouseMiddle]', target: chip }),
    ],
  ])('%s on a block ref opens its page behind the active tab, on the block', async (_, click) => {
    render(<Links />)

    await click(screen.getByText('block ref'))

    expect(activeTop()).toEqual({ pageId: 'CUR', title: 'Current' })
    expect(useTabsStore.getState().tabs[1]?.pageStack).toEqual([
      { pageId: 'REF_PAGE', title: 'Ref page' },
    ])
    expect(useNavigationStore.getState().selectedBlockId).toBeNull()

    useTabsStore.getState().switchTab(1)

    expect(activeTop()).toEqual({ pageId: 'REF_PAGE', title: 'Ref page' })
    expect(useNavigationStore.getState().selectedBlockId).toBe('REF')
  })

  it('a middle click on a chip opens it behind the active tab', async () => {
    const user = userEvent.setup()
    render(<Links />)

    await user.pointer({ keys: '[MouseMiddle]', target: screen.getByText('page link') })

    expect(useTabsStore.getState().tabs).toHaveLength(2)
    expect(useTabsStore.getState().activeTabIndex).toBe(0)
    expect(activeTop()).toEqual({ pageId: 'CUR', title: 'Current' })
    expect(useTabsStore.getState().tabs[1]?.pageStack).toEqual([
      { pageId: 'LINKED', title: 'Linked page' },
    ])
  })

  it('leaves a Ctrl+click off a chip, and a plain click on one, to the element', () => {
    render(<Links />)

    expect(fireEvent.click(screen.getByText('block text'), { ctrlKey: true })).toBe(true)
    fireEvent.click(screen.getByText('page link'))

    expect(onTextClick).toHaveBeenCalledTimes(1)
    expect(onTextClick.mock.calls[0]?.[0]).toMatchObject({ ctrlKey: true })
    expect(onChipClick).toHaveBeenCalledTimes(1)
    expect(useTabsStore.getState().tabs).toHaveLength(1)
  })
})
