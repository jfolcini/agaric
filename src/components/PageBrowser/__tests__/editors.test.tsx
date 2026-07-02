/**
 * #2245 — robustness / a11y branches of the AddFilterPopover facet editors.
 *
 * `LinkTargetEditor` (the LinksTo / LinkedFrom page picker) loads the space's
 * pages asynchronously; its three load outcomes — reject, slow-pending, and
 * empty — were previously only reachable via the happy path in
 * AddFilterPopover.test.tsx. Rendering the editor directly lets us drive the
 * `listAllPagesInSpace` promise deterministically (a deferred for the pending
 * spinner) and assert each recovery branch.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { LinkTargetEditor } from '@/components/PageBrowser/add-filter/editors'
import { t } from '@/lib/i18n'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)

function renderEditor() {
  const onSelect = vi.fn()
  const onBack = vi.fn()
  return {
    ...render(<LinkTargetEditor label="Links to" onSelect={onSelect} onBack={onBack} />),
    onSelect,
    onBack,
  }
}

describe('LinkTargetEditor load branches (#2245)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSpaceStore.setState({ currentSpaceId: 'SPACE_1' })
    useResolveStore.setState({ cache: new Map(), version: 0 })
  })

  it('recovers to the empty state without crashing when the page load rejects', async () => {
    // `listAllPagesInSpace` → invoke('list_all_pages_in_space') rejects.
    mockedInvoke.mockRejectedValueOnce(new Error('backend down'))

    const { container } = renderEditor()

    // The catch swallows the error and sets an empty list → empty state shows,
    // no thrown render, and aria-busy clears.
    expect(await screen.findByText(t('pageBrowser.filter.linkNoPages'))).toBeInTheDocument()
    expect(container.querySelector('[aria-busy="false"]')).toBeInTheDocument()
  })

  it('shows the aria-busy spinner while the load is pending', async () => {
    // Deferred: hold the promise open to observe the pending state.
    let resolvePages: (pages: Array<{ id: string; content: string }>) => void = () => {}
    mockedInvoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePages = resolve
        }),
    )

    const { container } = renderEditor()

    // Pending: the list region is marked aria-busy and the spinner is mounted.
    const busy = container.querySelector('[aria-busy="true"]')
    expect(busy).not.toBeNull()
    expect(busy?.querySelector('.animate-spin')).not.toBeNull()
    // Neither results nor the empty state render while loading.
    expect(screen.queryByText(t('pageBrowser.filter.linkNoPages'))).not.toBeInTheDocument()

    // Resolve → the spinner clears and results render.
    await act(async () => {
      resolvePages([{ id: 'PAGE_A', content: 'Roadmap' }])
    })
    await waitFor(() => expect(container.querySelector('[aria-busy="false"]')).toBeInTheDocument())
    expect(screen.getByText('Roadmap')).toBeInTheDocument()
  })

  it('shows the empty state when the space has no pages', async () => {
    mockedInvoke.mockResolvedValueOnce([])

    renderEditor()

    expect(await screen.findByText(t('pageBrowser.filter.linkNoPages'))).toBeInTheDocument()
  })

  it('has no a11y violations once the page list has loaded', async () => {
    mockedInvoke.mockResolvedValueOnce([{ id: 'PAGE_A', content: 'Roadmap' }])

    const { container } = renderEditor()
    await screen.findByText('Roadmap')

    expect(await axe(container)).toHaveNoViolations()
  })
})
