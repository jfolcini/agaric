/**
 * Tests for WelcomeModal component (F-31).
 *
 * Validates:
 *  - Shows when localStorage has no onboarding flag
 *  - Does NOT show when onboarding flag is set
 *  - "Get Started" dismisses and sets localStorage
 *  - "Create sample pages" calls createBlock
 *  - Does not show during boot loading state
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

// Mock lucide-react icons so we don't pull in the full icon library in tests.
vi.mock('lucide-react', () => ({
  FileText: (props: { className?: string }) => (
    <svg data-testid="icon-file-text" className={props.className} />
  ),
  Keyboard: (props: { className?: string }) => (
    <svg data-testid="icon-keyboard" className={props.className} />
  ),
  Tag: (props: { className?: string }) => (
    <svg data-testid="icon-tag" className={props.className} />
  ),
  XIcon: (props: { className?: string }) => (
    <svg data-testid="x-icon" className={props.className} />
  ),
}))

import { CLOSE_ALL_OVERLAYS_EVENT } from '../../lib/overlay-events'
import { useBootStore } from '../../stores/boot'
import { WelcomeModal } from '../WelcomeModal'

const mockedInvoke = vi.mocked(invoke)

/** No-op boot function to prevent side-effects. */
const noopBoot = vi.fn(async () => {})

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useBootStore.setState({ state: 'ready', error: null, boot: noopBoot })
})

describe('WelcomeModal', () => {
  it('shows when localStorage has no onboarding flag', () => {
    render(<WelcomeModal />)

    expect(screen.getByText('Welcome to Agaric')).toBeInTheDocument()
    expect(
      screen.getByText('A local-first note-taking app for organizing your thoughts.'),
    ).toBeInTheDocument()
  })

  it('does NOT show when onboarding flag is set', () => {
    localStorage.setItem('agaric-onboarding-done', 'true')

    render(<WelcomeModal />)

    expect(screen.queryByText('Welcome to Agaric')).not.toBeInTheDocument()
  })

  it('displays all three feature highlights', () => {
    render(<WelcomeModal />)

    expect(screen.getByText('Blocks + pages')).toBeInTheDocument()
    expect(screen.getByText('Keyboard shortcuts')).toBeInTheDocument()
    expect(screen.getByText('Tags + properties')).toBeInTheDocument()
  })

  // UX-278: feature list must use <ul role="list"> + <li> for proper SR semantics.
  it('renders the feature list with semantic <ul>/<li> markup', () => {
    render(<WelcomeModal />)

    const list = screen.getByRole('list')
    expect(list.tagName).toBe('UL')

    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(3)
    // Each <li> hosts one feature title
    expect(items[0]).toHaveTextContent('Blocks + pages')
    expect(items[1]).toHaveTextContent('Keyboard shortcuts')
    expect(items[2]).toHaveTextContent('Tags + properties')
  })

  it('"Get Started" dismisses and sets localStorage', async () => {
    const user = userEvent.setup()
    render(<WelcomeModal />)

    const getStartedBtn = screen.getByRole('button', { name: 'Get Started' })
    await user.click(getStartedBtn)

    expect(screen.queryByText('Welcome to Agaric')).not.toBeInTheDocument()
    expect(localStorage.getItem('agaric-onboarding-done')).toBe('true')
  })

  it('"Create sample pages" calls createBlock and dismisses', async () => {
    const user = userEvent.setup()

    // Mock createBlock calls — returns a fake block with an id
    let callCount = 0
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'create_block') {
        callCount++
        return {
          id: `block-${callCount}`,
          block_type: 'page',
          content: '',
          parent_id: null,
          position: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          deleted_at: null,
        }
      }
      return {}
    })

    render(<WelcomeModal />)

    const sampleBtn = screen.getByRole('button', { name: 'Create sample pages' })
    await user.click(sampleBtn)

    await waitFor(() => {
      // 2 pages + 3 child blocks each = 8 createBlock calls
      expect(mockedInvoke).toHaveBeenCalledTimes(8)
    })

    // Verify it created the two pages — assert via i18n keys (UX-278) so
    // a locale change cannot silently break the assertion.
    expect(mockedInvoke).toHaveBeenCalledWith(
      'create_block',
      expect.objectContaining({
        blockType: 'page',
        content: i18n.t('welcome.sampleGettingStartedTitle'),
      }),
    )
    expect(mockedInvoke).toHaveBeenCalledWith(
      'create_block',
      expect.objectContaining({
        blockType: 'page',
        content: i18n.t('welcome.sampleQuickTipsTitle'),
      }),
    )

    // Dialog should be dismissed
    await waitFor(() => {
      expect(screen.queryByText('Welcome to Agaric')).not.toBeInTheDocument()
    })
    expect(localStorage.getItem('agaric-onboarding-done')).toBe('true')
  })

  // UX-278: sample-page bodies must come from i18n keys so non-English
  // locales don't see English onboarding content.
  it('"Create sample pages" uses i18n strings for every block content', async () => {
    const user = userEvent.setup()

    let callCount = 0
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'create_block') {
        callCount++
        return {
          id: `block-${callCount}`,
          block_type: 'page',
          content: '',
          parent_id: null,
          position: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          deleted_at: null,
        }
      }
      return {}
    })

    render(<WelcomeModal />)
    await user.click(screen.getByRole('button', { name: 'Create sample pages' }))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledTimes(8)
    })

    // Every i18n-backed string must appear in the create_block payloads
    const expectedKeys = [
      'welcome.sampleGettingStartedTitle',
      'welcome.sampleGettingStartedBody1',
      'welcome.sampleGettingStartedBody2',
      'welcome.sampleGettingStartedBody3',
      'welcome.sampleQuickTipsTitle',
      'welcome.sampleQuickTipsBody1',
      'welcome.sampleQuickTipsBody2',
      'welcome.sampleQuickTipsBody3',
    ] as const

    for (const key of expectedKeys) {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'create_block',
        expect.objectContaining({ content: i18n.t(key) }),
      )
    }
  })

  it('does not show during boot loading state', () => {
    useBootStore.setState({ state: 'booting', error: null, boot: noopBoot })

    render(<WelcomeModal />)

    expect(screen.queryByText('Welcome to Agaric')).not.toBeInTheDocument()
  })

  it('does not show during boot recovering state', () => {
    useBootStore.setState({ state: 'recovering', error: null, boot: noopBoot })

    render(<WelcomeModal />)

    expect(screen.queryByText('Welcome to Agaric')).not.toBeInTheDocument()
  })

  it('does not show during boot error state', () => {
    useBootStore.setState({ state: 'error', error: 'Something broke', boot: noopBoot })

    render(<WelcomeModal />)

    expect(screen.queryByText('Welcome to Agaric')).not.toBeInTheDocument()
  })

  it('has no a11y violations when open', async () => {
    const { container } = render(<WelcomeModal />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations when dismissed', async () => {
    localStorage.setItem('agaric-onboarding-done', 'true')

    const { container } = render(<WelcomeModal />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // UX-228: the closeOverlays shortcut (Escape by default) dispatches a
  // window CustomEvent that WelcomeModal listens for. Verifies the modal
  // dismisses, marks onboarding done, and stays dismissed on re-render.
  describe('closeOverlays event (UX-228)', () => {
    it('dispatching agaric:closeAllOverlays closes the modal', async () => {
      render(<WelcomeModal />)

      // Sanity: modal is open
      expect(screen.getByText('Welcome to Agaric')).toBeInTheDocument()

      window.dispatchEvent(new CustomEvent(CLOSE_ALL_OVERLAYS_EVENT))

      await waitFor(() => {
        expect(screen.queryByText('Welcome to Agaric')).not.toBeInTheDocument()
      })
    })

    it('dispatching agaric:closeAllOverlays marks onboarding done', async () => {
      render(<WelcomeModal />)

      expect(localStorage.getItem('agaric-onboarding-done')).toBeNull()
      window.dispatchEvent(new CustomEvent(CLOSE_ALL_OVERLAYS_EVENT))

      await waitFor(() => {
        expect(localStorage.getItem('agaric-onboarding-done')).toBe('true')
      })
    })

    it('does not throw when event fires while modal is already closed', () => {
      localStorage.setItem('agaric-onboarding-done', 'true')
      render(<WelcomeModal />)

      // Should be a no-op — no error, no extra writes
      expect(() => {
        window.dispatchEvent(new CustomEvent(CLOSE_ALL_OVERLAYS_EVENT))
      }).not.toThrow()
    })

    it('unsubscribes on unmount', async () => {
      const { unmount } = render(<WelcomeModal />)

      unmount()

      // After unmount the handler should not run. We cannot assert the
      // callback directly, but we can verify localStorage does not get
      // written by the now-detached listener.
      localStorage.removeItem('agaric-onboarding-done')
      window.dispatchEvent(new CustomEvent(CLOSE_ALL_OVERLAYS_EVENT))
      await Promise.resolve()
      expect(localStorage.getItem('agaric-onboarding-done')).toBeNull()
    })

    it('has no a11y violations after dismissal via close-all-overlays', async () => {
      const { container } = render(<WelcomeModal />)
      window.dispatchEvent(new CustomEvent(CLOSE_ALL_OVERLAYS_EVENT))
      await waitFor(() => {
        expect(screen.queryByText('Welcome to Agaric')).not.toBeInTheDocument()
      })

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
