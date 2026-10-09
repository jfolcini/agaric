/**
 * Tests for ActivityFeed — error-path coverage (#1270).
 *
 * The feed's per-entry Undo button (and per-session bulk revert) call
 * the `revertOps` IPC. On rejection the handler must surface a failure
 * toast (`notify.error`) and keep the entry's button available for
 * retry rather than swallow the error. These tests cover the rejected
 * single-entry undo plus the happy path.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { makePage } from '@/__tests__/fixtures'
import { ActivityFeed } from '@/components/agent-access/ActivityFeed'
import type { ActivityEntry } from '@/hooks/useMcpActivityFeed'
import {
  _resetGraphStructureEventsForTest,
  getGraphStructureKey,
} from '@/lib/graph-structure-events'
import { t } from '@/lib/i18n'
import { notify } from '@/lib/notify'
import { useRecentPagesStore } from '@/stores/recent-pages'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'
import type { Tab } from '@/stores/tabs'
import { useTabsStore } from '@/stores/tabs'

const { mockRevert, mockListBlocks, mockListAllTagsInSpace, mockBatchResolve } = vi.hoisted(() => ({
  mockRevert: vi.fn(),
  mockListBlocks: vi.fn(),
  mockListAllTagsInSpace: vi.fn(),
  mockBatchResolve: vi.fn(),
}))

vi.mock('@/lib/bindings', () => ({
  commands: {
    revertOps: (...args: unknown[]) => mockRevert(...args),
    // The resolve-cache re-reads a successful revert triggers (#5276).
    listBlocks: (...args: unknown[]) => mockListBlocks(...args),
    listAllTagsInSpace: (...args: unknown[]) => mockListAllTagsInSpace(...args),
    batchResolve: (...args: unknown[]) => mockBatchResolve(...args),
  },
}))

/** Wrap a value in the `Result`-shaped IPC envelope `commands.*` returns. */
const ok = <T,>(data: T) => ({ status: 'ok' as const, data })

vi.mock('@/lib/notify', () => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const mockNotify = vi.mocked(notify)

// An agent-authored, successful RW entry with an opRef → the only
// shape that renders the per-entry Undo button.
const UNDOABLE: ActivityEntry = {
  toolName: 'edit_block',
  summary: 'Edited a block',
  timestamp: new Date().toISOString(),
  actorKind: 'agent',
  result: { kind: 'ok' },
  sessionId: 'sess-1',
  opRef: { device_id: 'dev-1', seq: 9 },
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('ActivityFeed', () => {
  it('titles the feed with an h2 and renders the empty message as a paragraph, not a heading', async () => {
    const { container } = render(<ActivityFeed entries={[]} />)

    expect(screen.getAllByRole('heading')).toEqual([
      screen.getByRole('heading', { level: 2, name: t('agentAccess.activityLabel') }),
    ])
    expect(screen.getByText(t('agentAccess.activityEmpty'))).toBeInTheDocument()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('undoing an agent op fires revertOps and toasts success', async () => {
    const user = userEvent.setup()
    mockRevert.mockResolvedValue(ok([]))
    render(<ActivityFeed entries={[UNDOABLE]} />)
    await user.click(screen.getByTestId('mcp-activity-undo'))
    await waitFor(() => {
      expect(mockRevert).toHaveBeenCalledWith([UNDOABLE.opRef])
      expect(mockNotify.success).toHaveBeenCalled()
    })
  })

  // #1270 error-path: a rejected revertOps must surface a failure
  // toast, not be swallowed.
  it('surfaces a failure toast when revertOps rejects', async () => {
    const user = userEvent.setup()
    mockRevert.mockRejectedValueOnce(new Error('ipc boom'))
    render(<ActivityFeed entries={[UNDOABLE]} />)
    await user.click(screen.getByTestId('mcp-activity-undo'))
    await waitFor(() => {
      expect(mockNotify.error).toHaveBeenCalled()
    })
    // The button stays available for retry — the success-terminal state
    // is NOT applied on failure.
    expect(screen.getByTestId('mcp-activity-undo')).toBeInTheDocument()
  })

  // #5394 — one tool call can write several ops (a DONE stamps `completed_at`
  // and creates the next occurrence); undoing the entry must revert all of
  // them, and the call still counts as one action.
  describe('multi-op entries (#5394)', () => {
    const MULTI_OP: ActivityEntry = {
      ...UNDOABLE,
      toolName: 'set_property',
      opRef: { device_id: 'dev-1', seq: 20 },
      additionalOpRefs: [
        { device_id: 'dev-1', seq: 21 },
        { device_id: 'dev-1', seq: 22 },
      ],
    }

    it('Undo reverts every op the call wrote', async () => {
      const user = userEvent.setup()
      mockRevert.mockResolvedValue(ok([]))
      const { container } = render(<ActivityFeed entries={[MULTI_OP]} />)
      expect(screen.queryByTestId('mcp-activity-session-header')).not.toBeInTheDocument()

      await user.click(screen.getByTestId('mcp-activity-undo'))

      await waitFor(() => {
        expect(mockRevert).toHaveBeenCalledWith([
          { device_id: 'dev-1', seq: 20 },
          { device_id: 'dev-1', seq: 21 },
          { device_id: 'dev-1', seq: 22 },
        ])
      })
      expect(await axe(container)).toHaveNoViolations()
    })

    it('Revert session reverts every op of every action, counted per action', async () => {
      const user = userEvent.setup()
      mockRevert.mockResolvedValue(ok([]))
      render(<ActivityFeed entries={[MULTI_OP, UNDOABLE]} />)
      expect(screen.getByTestId('mcp-activity-session-header')).toHaveTextContent(
        t('agentAccess.revertSession.headerLabel', { count: 2 }),
      )

      await user.click(screen.getByTestId('mcp-activity-revert-session'))
      await user.click(
        screen.getByRole('button', { name: t('agentAccess.revertSession.confirmAction') }),
      )

      await waitFor(() => {
        expect(mockRevert).toHaveBeenCalledWith([
          { device_id: 'dev-1', seq: 20 },
          { device_id: 'dev-1', seq: 21 },
          { device_id: 'dev-1', seq: 22 },
          { device_id: 'dev-1', seq: 9 },
        ])
        expect(mockNotify.success).toHaveBeenCalledWith(
          t('agentAccess.revertSession.success', { count: 2 }),
        )
      })
    })
  })

  // #3546 — the non-reversible branch narrows with the SHARED
  // `isNonReversible` predicate from `@/lib/app-error`, not a local
  // re-implementation. The two were not equivalent: the local copy accepted
  // ANY object carrying `kind === 'non_reversible'`, while the shared one
  // also requires the `message: string` half of the `{ kind, message }`
  // envelope every real `AppError` serialises. The pair below pins both
  // halves of that difference, so re-introducing the looser local copy reds
  // the second case.
  describe('non-reversible narrowing (#3546)', () => {
    it('a full { kind, message } AppError takes the dedicated non-reversible toast', async () => {
      const user = userEvent.setup()
      // `commands.*` returns the Result envelope; `unwrap` throws `.error`,
      // which is where the raw IPC `AppError` lands.
      mockRevert.mockResolvedValueOnce({
        status: 'error' as const,
        error: {
          kind: 'non_reversible',
          message: 'Non-reversible operation: purge_block cannot be undone',
        },
      })
      render(<ActivityFeed entries={[UNDOABLE]} />)
      await user.click(screen.getByTestId('mcp-activity-undo'))

      await waitFor(() => {
        expect(mockNotify.error).toHaveBeenCalledWith('This agent action cannot be undone')
      })
      expect(mockNotify.error).not.toHaveBeenCalledWith('Could not undo agent action')
    })

    it('a message-less non_reversible lookalike takes the GENERIC failure toast', async () => {
      const user = userEvent.setup()
      // No `message` → not an `AppError` by the app-wide definition
      // (`isAppError`), so the feed must not claim the backend said
      // "non-reversible". The retired local predicate accepted this.
      mockRevert.mockResolvedValueOnce({
        status: 'error' as const,
        error: { kind: 'non_reversible' },
      })
      render(<ActivityFeed entries={[UNDOABLE]} />)
      await user.click(screen.getByTestId('mcp-activity-undo'))

      await waitFor(() => {
        expect(mockNotify.error).toHaveBeenCalledWith('Could not undo agent action')
      })
      expect(mockNotify.error).not.toHaveBeenCalledWith('This agent action cannot be undone')
    })
  })

  // #5276 — an agent's write reverted here rewrites pages behind every store's
  // back, so the undo must carry the change into the titles and deleted marks
  // the chips, tabs and recents hold, as a sync does.
  describe('revert fan-out (#5276)', () => {
    // The second op is the session's other agent write, so the session header renders.
    const SESSION_MATE: ActivityEntry = { ...UNDOABLE, opRef: { device_id: 'dev-1', seq: 10 } }

    beforeEach(() => {
      useSpaceStore.setState({
        currentSpaceId: 'SPACE_A',
        availableSpaces: [{ id: 'SPACE_A', name: 'A', accent_color: null }],
        isReady: true,
      })
      // The agent renamed page "Alpha" to "Beta" and deleted a referenced block.
      useResolveStore.setState({ cache: new Map(), version: 0, _preloaded: false })
      useResolveStore.getState().set('PAGE_P', 'Beta', false)
      useResolveStore.getState().set('BLOCK_B', 'Referenced block', true)
      const held = [{ pageId: 'PAGE_P', title: 'Beta' }]
      const tabs: Tab[] = [{ id: '0', pageStack: held, label: 'Beta' }]
      useTabsStore.setState({
        tabs,
        activeTabIndex: 0,
        tabsBySpace: { SPACE_A: tabs },
        activeTabIndexBySpace: { SPACE_A: 0 },
      })
      useRecentPagesStore.setState({ recentPages: held, recentPagesBySpace: { SPACE_A: held } })
      mockListBlocks.mockResolvedValue(
        ok({
          items: [makePage({ id: 'PAGE_P', content: 'Alpha' })],
          next_cursor: null,
          has_more: false,
          total_count: null,
        }),
      )
      mockListAllTagsInSpace.mockResolvedValue(ok([]))
      mockBatchResolve.mockResolvedValue(
        ok([{ id: 'BLOCK_B', title: 'Referenced block', block_type: 'content', deleted: false }]),
      )
      _resetGraphStructureEventsForTest()
    })

    afterEach(() => {
      useSpaceStore.setState({ currentSpaceId: null, availableSpaces: [], isReady: false })
      useTabsStore.setState({
        tabs: [{ id: '0', pageStack: [], label: '' }],
        activeTabIndex: 0,
        tabsBySpace: {},
        activeTabIndexBySpace: {},
      })
      useRecentPagesStore.setState({ recentPages: [], recentPagesBySpace: {} })
      useResolveStore.setState({ cache: new Map(), version: 0, _preloaded: false })
    })

    function heldState() {
      const resolve = useResolveStore.getState()
      const tab = useTabsStore.getState().tabs[0]
      return {
        chipTitle: resolve.resolveTitle('PAGE_P'),
        blockStatus: resolve.resolveStatus('BLOCK_B'),
        tabTitle: tab?.pageStack[0]?.title,
        tabLabel: tab?.label,
        recentTitle: useRecentPagesStore.getState().recentPagesBySpace['SPACE_A']?.[0]?.title,
      }
    }

    const BEFORE = {
      chipTitle: 'Beta',
      blockStatus: 'deleted',
      tabTitle: 'Beta',
      tabLabel: 'Beta',
      recentTitle: 'Beta',
    }

    async function undoOne(user: ReturnType<typeof userEvent.setup>): Promise<void> {
      await user.click(screen.getByTestId('mcp-activity-undo'))
    }

    async function revertSession(user: ReturnType<typeof userEvent.setup>): Promise<void> {
      await user.click(screen.getByTestId('mcp-activity-revert-session'))
      await user.click(
        screen.getByRole('button', { name: t('agentAccess.revertSession.confirmAction') }),
      )
    }

    const REVERTS = [
      ['Undo', [UNDOABLE], undoOne, 'agentAccess.undoAgentOp.failed'],
      [
        'Revert session',
        [UNDOABLE, SESSION_MATE],
        revertSession,
        'agentAccess.revertSession.failed',
      ],
    ] as const

    it.each(REVERTS)(
      'a successful %s re-resolves held titles and deleted marks',
      async (_, entries, revert) => {
        const user = userEvent.setup()
        mockRevert.mockResolvedValue(ok([]))
        render(<ActivityFeed entries={[...entries]} />)
        expect(heldState()).toEqual(BEFORE)

        await revert(user)

        await waitFor(() => {
          expect(heldState()).toEqual({
            chipTitle: 'Alpha',
            blockStatus: 'active',
            tabTitle: 'Alpha',
            tabLabel: 'Alpha',
            recentTitle: 'Alpha',
          })
          expect(getGraphStructureKey()).toBe(1)
        })
      },
    )

    it.each(REVERTS)('a failed %s leaves them alone', async (_, entries, revert, failedKey) => {
      const user = userEvent.setup()
      mockRevert.mockRejectedValue(new Error('ipc boom'))
      render(<ActivityFeed entries={[...entries]} />)

      await revert(user)

      await waitFor(() => {
        expect(mockNotify.error).toHaveBeenCalledWith(t(failedKey))
      })
      // The re-reads that would rewrite them start in the same tick as the fan-out.
      expect(mockListBlocks).not.toHaveBeenCalled()
      expect(mockBatchResolve).not.toHaveBeenCalled()
      expect(heldState()).toEqual(BEFORE)
    })
  })
})
