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

    // Verify it created the two pages
    expect(mockedInvoke).toHaveBeenCalledWith(
      'create_block',
      expect.objectContaining({
        blockType: 'page',
        content: 'Getting Started',
      }),
    )
    expect(mockedInvoke).toHaveBeenCalledWith(
      'create_block',
      expect.objectContaining({
        blockType: 'page',
        content: 'Quick Tips',
      }),
    )

    // Dialog should be dismissed
    await waitFor(() => {
      expect(screen.queryByText('Welcome to Agaric')).not.toBeInTheDocument()
    })
    expect(localStorage.getItem('agaric-onboarding-done')).toBe('true')
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
})
