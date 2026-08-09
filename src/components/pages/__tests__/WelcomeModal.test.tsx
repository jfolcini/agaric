/**
 * Tests for WelcomeModal component (F-31).
 *
 * Validates:
 *  - Shows when localStorage has no onboarding flag
 *  - Does NOT show when onboarding flag is set
 *  - "Get Started" dismisses and sets localStorage
 *  - "Create sample pages" routes through createPageInSpace + createBlock
 *  - Does not show during boot loading state
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

// Mock lucide-react icons so we don't pull in the full icon library in tests.
// #214 Phase 1B replaced the six abstract feature icons with three workflow
// icons (SquareSlash, AtSign, Bold).
vi.mock('lucide-react', () => ({
  SquareSlash: (props: { className?: string }) => (
    <svg data-testid="icon-square-slash" className={props.className} />
  ),
  AtSign: (props: { className?: string }) => (
    <svg data-testid="icon-at-sign" className={props.className} />
  ),
  Bold: (props: { className?: string }) => (
    <svg data-testid="icon-bold" className={props.className} />
  ),
  XIcon: (props: { className?: string }) => (
    <svg data-testid="x-icon" className={props.className} />
  ),
  // The in-flight submit Spinner renders <Loader2/>; forward props so its
  // `data-slot="spinner"` marker survives for the pending-state assertion.
  Loader2: (props: Record<string, unknown>) => <svg data-testid="icon-loader2" {...props} />,
}))

import { WelcomeModal } from '@/components/pages/WelcomeModal'
import { useIsMobile } from '@/hooks/useIsMobile'
import { CLOSE_ALL_OVERLAYS_EVENT } from '@/lib/overlay-events'
import { useBootStore } from '@/stores/boot'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
}))

const mockedInvoke = vi.mocked(invoke)
const mockedUseIsMobile = vi.mocked(useIsMobile)

/** No-op boot function to prevent side-effects. */
const noopBoot = vi.fn(async () => {})

/** Stands in for the real tabs-store navigation so the success path is observable. */
const navigateToPageSpy = vi.fn()

/**
 * #3308 — a stateful fake of the sample-pages IPC surface.
 *
 * `createSamplePages` is idempotent now: it sweeps the space with
 * `list_all_pages_in_space` first, reuses a page whose title already
 * matches, and (for a reused page) reads its children via `list_blocks` so
 * only the missing bodies are re-created. A stateless per-command mock
 * cannot express that, so this helper keeps the created pages/blocks in
 * memory and serves them back, exactly like the backend would across a
 * failed-then-retried run.
 *
 * `failCreateBlockCall: n` makes the n-th `create_block` reject, which is
 * the mid-sequence failure the duplicate-prevention regression turns on.
 */
function installSampleIpcMock(opts: { failCreateBlockCall?: number } = {}): {
  pages: { id: string; content: string }[]
  blocks: { id: string; content: string; parent_id: string }[]
} {
  const pages: { id: string; content: string }[] = []
  const blocks: { id: string; content: string; parent_id: string }[] = []
  let createBlockCalls = 0

  mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === 'list_all_pages_in_space') {
      return pages.map((page) => ({
        id: page.id,
        content: page.content,
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
      }))
    }
    if (cmd === 'create_page_in_space') {
      const content = (args as { content: string }).content
      const id = `page-${pages.length + 1}`
      pages.push({ id, content })
      return id
    }
    if (cmd === 'list_blocks') {
      const parentId = (args as { request: { parentId: string | null } }).request.parentId
      return {
        items: blocks
          .filter((block) => block.parent_id === parentId)
          .map((block) => ({
            id: block.id,
            block_type: 'content',
            content: block.content,
            parent_id: block.parent_id,
            position: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            deleted_at: null,
          })),
        next_cursor: null,
        has_more: false,
        total: null,
      }
    }
    if (cmd === 'create_block') {
      createBlockCalls += 1
      if (opts.failCreateBlockCall === createBlockCalls) {
        throw new Error('database is locked')
      }
      const { content, parentId } = args as { content: string; parentId: string }
      const id = `block-${blocks.length + 1}`
      blocks.push({ id, content, parent_id: parentId })
      return {
        id,
        block_type: 'content',
        content,
        parent_id: parentId,
        position: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deleted_at: null,
      }
    }
    return {}
  })

  return { pages, blocks }
}

/** Titles passed to `create_page_in_space`, in call order. */
function createdPageTitles(): string[] {
  return mockedInvoke.mock.calls
    .filter(([cmd]) => cmd === 'create_page_in_space')
    .map(([, args]) => (args as { content: string }).content)
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  // Default to the desktop path so existing test bodies keep their semantics.
  mockedUseIsMobile.mockReturnValue(false)
  useBootStore.setState({ state: 'ready', error: null, boot: noopBoot })
  // H-3b — WelcomeModal routes onboarding sample-page creation
  // through `createPageInSpace`, which reads
  // `useSpaceStore.getState().currentSpaceId`. On a fresh first boot the
  // SpaceStore has hydrated to whichever space sorts first
  // alphabetically (Personal by default); seed the test store so the
  // sample-pages flow doesn't bail.
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
  // #3308 — the success path navigates to the Getting Started page. Stub
  // the store action so the assertion is direct and the real cross-store
  // navigation cascade stays out of these component tests.
  useTabsStore.setState({ navigateToPage: navigateToPageSpy })
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

  // #214 Phase 1B — the welcome modal now teaches three concrete
  // workflows instead of six abstract feature blurbs.
  it('displays the three workflow rows', () => {
    render(<WelcomeModal />)

    expect(screen.getByText('Press / for tasks & dates')).toBeInTheDocument()
    expect(screen.getByText('Type [[ to link, @ to tag')).toBeInTheDocument()
    expect(screen.getByText('Select text to format')).toBeInTheDocument()
  })

  // Feature list must use <ul role="list"> + <li> for proper SR
  // semantics. #214 Phase 1B reduced six rows to three workflows.
  it('renders the workflow list with semantic <ul>/<li> markup', () => {
    render(<WelcomeModal />)

    const list = screen.getByRole('list')
    expect(list.tagName).toBe('UL')

    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('Press / for tasks & dates')
    expect(items[1]).toHaveTextContent('Type [[ to link, @ to tag')
    expect(items[2]).toHaveTextContent('Select text to format')
  })

  // #214 Phase 1B — the slash workflow row teaches the command menu and
  // uses the SquareSlash icon.
  it('renders the slash workflow row first with its description and icon (#214)', () => {
    render(<WelcomeModal />)

    const items = screen.getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('Press / for tasks & dates')
    expect(items[0]).toHaveTextContent(
      'Open the command menu to add tasks, dates, headings, and more.',
    )
    expect(items[0]?.querySelector('[data-testid="icon-square-slash"]')).not.toBeNull()
  })

  // #214 Phase 1B — the link/tag workflow row teaches the `[[` and `@`
  // triggers and uses the AtSign icon.
  it('renders the link/tag workflow row with both triggers and the AtSign icon (#214)', () => {
    render(<WelcomeModal />)

    const items = screen.getAllByRole('listitem')
    expect(items[1]).toHaveTextContent('[[')
    expect(items[1]).toHaveTextContent('@')
    expect(items[1]?.querySelector('[data-testid="icon-at-sign"]')).not.toBeNull()
  })

  // #214 Phase 1B — the formatting workflow row teaches the select-to-format
  // gesture and uses the Bold icon.
  it('renders the formatting workflow row last with the Bold icon (#214)', () => {
    render(<WelcomeModal />)

    const items = screen.getAllByRole('listitem')
    expect(items[2]).toHaveTextContent('Select text to format')
    expect(items[2]?.querySelector('[data-testid="icon-bold"]')).not.toBeNull()
  })

  // #214 Phase 1B — the old six abstract feature blurbs must be gone.
  it('no longer renders the old abstract feature blurbs (#214)', () => {
    render(<WelcomeModal />)

    expect(screen.queryByText('Blocks + pages')).not.toBeInTheDocument()
    expect(screen.queryByText('Sync across devices')).not.toBeInTheDocument()
    expect(screen.queryByText('Reference syntax')).not.toBeInTheDocument()
  })

  it('"Get Started" dismisses and sets localStorage', async () => {
    const user = userEvent.setup()
    render(<WelcomeModal />)

    const getStartedBtn = screen.getByRole('button', { name: 'Get Started' })
    await user.click(getStartedBtn)

    expect(screen.queryByText('Welcome to Agaric')).not.toBeInTheDocument()
    expect(localStorage.getItem('agaric-onboarding-done')).toBe('true')
  })

  // H-3b — page creation routes through `create_page_in_space`
  // (returns the new ULID as a plain string). Content blocks still use
  // `create_block`. So the sequence is:
  //   2× `create_page_in_space` (Getting Started + Quick Tips)
  // + 6× `create_block` (3 content children for each page)
  // = 8 IPC invocations, plus the #3308 idempotence sweep
  // (`list_all_pages_in_space`) that runs first = 9 total.
  it('"Create sample pages" calls create_page_in_space + create_block and dismisses', async () => {
    const user = userEvent.setup()

    installSampleIpcMock()

    render(<WelcomeModal />)

    const sampleBtn = screen.getByRole('button', { name: 'Create sample pages' })
    await user.click(sampleBtn)

    await waitFor(() => {
      // 1 existing-page sweep + 2 page creates + 6 child block creates.
      expect(mockedInvoke).toHaveBeenCalledTimes(9)
    })

    // Verify it created the two pages via the new IPC — assert via i18n
    // Keys so a locale change cannot silently break the test.
    expect(mockedInvoke).toHaveBeenCalledWith(
      'create_page_in_space',
      expect.objectContaining({
        spaceId: 'SPACE_TEST',
        content: i18n.t('welcome.sampleGettingStartedTitle'),
      }),
    )
    expect(mockedInvoke).toHaveBeenCalledWith(
      'create_page_in_space',
      expect.objectContaining({
        spaceId: 'SPACE_TEST',
        content: i18n.t('welcome.sampleQuickTipsTitle'),
      }),
    )

    // Negative assertion: NO `create_block` IPC fired with `blockType=page`
    // (would mean the legacy bypass path crept back in).
    const legacyCreatePageCalls = mockedInvoke.mock.calls.filter(
      ([cmd, args]) =>
        cmd === 'create_block' && (args as { blockType?: string }).blockType === 'page',
    )
    expect(legacyCreatePageCalls).toHaveLength(0)

    // Dialog should be dismissed
    await waitFor(() => {
      expect(screen.queryByText('Welcome to Agaric')).not.toBeInTheDocument()
    })
    expect(localStorage.getItem('agaric-onboarding-done')).toBe('true')
  })

  // Sample-page bodies must come from i18n keys so non-English
  // locales don't see English onboarding content.
  it('"Create sample pages" uses i18n strings for every block content', async () => {
    const user = userEvent.setup()

    installSampleIpcMock()

    render(<WelcomeModal />)
    await user.click(screen.getByRole('button', { name: 'Create sample pages' }))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledTimes(9)
    })

    // Page titles ride on `create_page_in_space`.
    expect(mockedInvoke).toHaveBeenCalledWith(
      'create_page_in_space',
      expect.objectContaining({ content: i18n.t('welcome.sampleGettingStartedTitle') }),
    )
    expect(mockedInvoke).toHaveBeenCalledWith(
      'create_page_in_space',
      expect.objectContaining({ content: i18n.t('welcome.sampleQuickTipsTitle') }),
    )

    // Body content blocks ride on `create_block`.
    const bodyKeys = [
      'welcome.sampleGettingStartedBody1',
      'welcome.sampleGettingStartedBody2',
      'welcome.sampleGettingStartedBody3',
      'welcome.sampleQuickTipsBody1',
      'welcome.sampleQuickTipsBody2',
      'welcome.sampleQuickTipsBody3',
    ] as const

    for (const key of bodyKeys) {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'create_block',
        expect.objectContaining({ content: i18n.t(key) }),
      )
    }
  })

  // IPC error-path coverage. The "Create sample pages" flow
  // wraps the create-page chain in try/catch and surfaces failures via
  // toast.error. A regression where the catch block is dropped (or the
  // toast call goes missing) would leave the user staring at a stuck
  // dialog with no signal — this test pins the contract: rejection →
  // error toast, modal stays open, onboarding flag is NOT persisted.
  it('shows an error toast and keeps the modal open when create_page_in_space rejects', async () => {
    const user = userEvent.setup()
    const mockedToastError = vi.mocked(toast.error)

    // First create_page_in_space call (Getting Started page) rejects —
    // the remaining calls are short-circuited by the try/catch.
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_all_pages_in_space') return []
      throw new Error('database is locked')
    })

    render(<WelcomeModal />)
    await user.click(screen.getByRole('button', { name: 'Create sample pages' }))

    await waitFor(() => {
      // #3308 — the message is unchanged; it now rides with a Retry action
      // (asserted in detail by the dedicated regression below).
      expect(mockedToastError).toHaveBeenCalledWith(
        i18n.t('welcome.samplePagesFailed'),
        expect.objectContaining({ action: expect.anything() }),
      )
    })

    // Modal stays open; onboarding flag NOT set so the user can retry
    // (or pick a different action) on next launch.
    expect(screen.getByText('Welcome to Agaric')).toBeInTheDocument()
    expect(localStorage.getItem('agaric-onboarding-done')).toBeNull()
  })

  // ----------------------------------------------------------------------
  // #3308 finding 1 — the onboarding path had no idempotence and no
  // recovery: a rejection mid-way through the eight-IPC sequence left
  // half-built pages behind a still-open modal whose still-enabled button
  // duplicated them on the next click, the error toast offered no retry,
  // and the success path navigated nowhere.
  // ----------------------------------------------------------------------
  describe('sample pages are idempotent and recoverable (#3308)', () => {
    it('does not create a duplicate Getting Started page on a second click after a mid-sequence failure', async () => {
      const user = userEvent.setup()

      // The Getting Started page lands, then its SECOND body block rejects
      // — the classic half-built state.
      const { pages } = installSampleIpcMock({ failCreateBlockCall: 2 })

      render(<WelcomeModal />)
      await user.click(screen.getByRole('button', { name: 'Create sample pages' }))

      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalled()
      })
      expect(createdPageTitles()).toEqual([i18n.t('welcome.sampleGettingStartedTitle')])

      // The button is re-enabled; the user clicks it again.
      const sampleBtn = screen.getByRole('button', { name: 'Create sample pages' })
      expect(sampleBtn).toBeEnabled()
      await user.click(sampleBtn)

      await waitFor(() => {
        expect(vi.mocked(toast.success)).toHaveBeenCalledWith(i18n.t('welcome.samplePagesCreated'))
      })

      // Getting Started was created exactly ONCE across both attempts; the
      // retry reused it and only added Quick Tips.
      expect(createdPageTitles()).toEqual([
        i18n.t('welcome.sampleGettingStartedTitle'),
        i18n.t('welcome.sampleQuickTipsTitle'),
      ])
      expect(
        pages.filter((page) => page.content === i18n.t('welcome.sampleGettingStartedTitle')),
      ).toHaveLength(1)
    })

    it('back-fills only the missing body blocks when reusing a half-built Getting Started page', async () => {
      const user = userEvent.setup()

      const { blocks } = installSampleIpcMock({ failCreateBlockCall: 2 })

      render(<WelcomeModal />)
      await user.click(screen.getByRole('button', { name: 'Create sample pages' }))
      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalled()
      })

      await user.click(screen.getByRole('button', { name: 'Create sample pages' }))
      await waitFor(() => {
        expect(vi.mocked(toast.success)).toHaveBeenCalled()
      })

      // Every body exists exactly once — no duplicated block 1.
      for (const key of [
        'welcome.sampleGettingStartedBody1',
        'welcome.sampleGettingStartedBody2',
        'welcome.sampleGettingStartedBody3',
        'welcome.sampleQuickTipsBody1',
        'welcome.sampleQuickTipsBody2',
        'welcome.sampleQuickTipsBody3',
      ] as const) {
        expect(blocks.filter((block) => block.content === i18n.t(key))).toHaveLength(1)
      }
    })

    // UX.md:113 — "Error states must include a way to retry or recover."
    it('the sample-pages failure toast carries a working Retry action', async () => {
      const user = userEvent.setup()

      installSampleIpcMock({ failCreateBlockCall: 2 })

      render(<WelcomeModal />)
      await user.click(screen.getByRole('button', { name: 'Create sample pages' }))

      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalled()
      })

      const opts = vi.mocked(toast.error).mock.calls.at(-1)?.[1] as
        | { action?: { label?: string; onClick?: () => void } }
        | undefined
      expect(opts?.action?.label).toBe(i18n.t('action.retry'))
      expect(typeof opts?.action?.onClick).toBe('function')

      // The action actually re-runs the flow (and, being idempotent, it
      // completes rather than duplicating).
      opts?.action?.onClick?.()
      await waitFor(() => {
        expect(vi.mocked(toast.success)).toHaveBeenCalledWith(i18n.t('welcome.samplePagesCreated'))
      })
      expect(createdPageTitles()).toEqual([
        i18n.t('welcome.sampleGettingStartedTitle'),
        i18n.t('welcome.sampleQuickTipsTitle'),
      ])
    })

    it('navigates to the Getting Started page after creating the sample pages', async () => {
      const user = userEvent.setup()

      installSampleIpcMock()

      render(<WelcomeModal />)
      await user.click(screen.getByRole('button', { name: 'Create sample pages' }))

      await waitFor(() => {
        expect(navigateToPageSpy).toHaveBeenCalledWith(
          'page-1',
          i18n.t('welcome.sampleGettingStartedTitle'),
        )
      })
    })

    it('navigates to the REUSED Getting Started page when one already exists', async () => {
      const user = userEvent.setup()

      const { pages } = installSampleIpcMock()
      pages.push({ id: 'PAGE_EXISTING', content: i18n.t('welcome.sampleGettingStartedTitle') })

      render(<WelcomeModal />)
      await user.click(screen.getByRole('button', { name: 'Create sample pages' }))

      await waitFor(() => {
        expect(navigateToPageSpy).toHaveBeenCalledWith(
          'PAGE_EXISTING',
          i18n.t('welcome.sampleGettingStartedTitle'),
        )
      })
      expect(createdPageTitles()).toEqual([i18n.t('welcome.sampleQuickTipsTitle')])
    })
  })

  // Item #2281 — the async submit button must render the app-wide in-flight
  // <Spinner/> (not just go disabled) while the create-sample-pages IPC chain is
  // pending, matching ConfirmDialog / TemplatesView.
  it('shows an in-flight Spinner in the "Create sample pages" button while creation is pending', async () => {
    const user = userEvent.setup()
    let resolveFirstPage: (id: string) => void = () => {}
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_all_pages_in_space') return []
      if (cmd === 'create_page_in_space') {
        return new Promise<string>((resolve) => {
          resolveFirstPage = resolve
        })
      }
      return {}
    })

    render(<WelcomeModal />)
    await user.click(screen.getByRole('button', { name: 'Create sample pages' }))

    const sampleBtn = screen.getByRole('button', { name: 'Create sample pages' })
    await waitFor(() => {
      expect(sampleBtn.querySelector('[data-slot="spinner"]')).not.toBeNull()
    })
    expect(sampleBtn).toBeDisabled()

    // Let the pending promise settle so the component unmounts cleanly.
    resolveFirstPage('PAGE_1')
  })

  it('does not show during boot loading state', () => {
    useBootStore.setState({ state: 'booting', error: null, boot: noopBoot })

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

  // The closeOverlays shortcut (Escape by default) dispatches a
  // window CustomEvent that WelcomeModal listens for. Verifies the modal
  // dismisses, marks onboarding done, and stays dismissed on re-render.
  describe('closeOverlays event', () => {
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

  // ----------------------------------------------------------------------
  // Modal mounts under both desktop (Dialog) and mobile (Sheet)
  // paths via useDialogOrSheet('dialog'). We don't assert on Radix DOM
  // specifics — just that the title / body content / buttons are
  // accessible under both code paths.
  // ----------------------------------------------------------------------

  describe('responsive path', () => {
    it('mounts on the mobile path (Sheet) with title, workflow list, and buttons accessible', () => {
      mockedUseIsMobile.mockReturnValue(true)

      render(<WelcomeModal />)

      expect(screen.getByText('Welcome to Agaric')).toBeInTheDocument()
      // Workflow list still renders inline on mobile (#214 Phase 1B: 3 rows).
      expect(screen.getAllByRole('listitem')).toHaveLength(3)
      expect(screen.getByRole('button', { name: 'Get Started' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Create sample pages' })).toBeInTheDocument()
    })

    it('mounts on the desktop path (Dialog) with title, workflow list, and buttons accessible', () => {
      mockedUseIsMobile.mockReturnValue(false)

      render(<WelcomeModal />)

      expect(screen.getByText('Welcome to Agaric')).toBeInTheDocument()
      expect(screen.getAllByRole('listitem')).toHaveLength(3)
      expect(screen.getByRole('button', { name: 'Get Started' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Create sample pages' })).toBeInTheDocument()
    })
  })
})
