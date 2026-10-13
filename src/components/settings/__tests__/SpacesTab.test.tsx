/**
 * Tests for SpacesTab (Settings › Spaces, #5362).
 *
 * IPC runs through the in-memory tauri mock, so a mutation is asserted on
 * what `list_spaces` returns afterwards, not on the call that made it. The
 * one command stubbed instead is the emptiness probe: the mock's
 * `list_blocks` ignores the space scope, so it answers here the way the
 * backend does for the seed (Personal holds the seeded pages, a new space
 * holds nothing).
 *
 * Coverage: render, open-on-launch choice (persisted, used by the next
 * launch, reset when its space is deleted), create, rename, recolour,
 * delete (disabled while not empty, on the last space), IPC rejections, the
 * per-visit emptiness probe (#5284), and axe in the default, create-form and
 * delete-confirm states.
 */

import { type InvokeArgs, invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyPage } from '@/__tests__/fixtures'
import { axe } from '@/__tests__/helpers/axe'
import { SpacesTab } from '@/components/settings/SpacesTab'
import type { SpaceRow } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { PREFERENCES, readPreference, writePreference } from '@/lib/preferences'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { seedBlocks } from '@/lib/tauri-mock/seed'
import { useSpaceStore } from '@/stores/space'

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// ConfirmDialog swaps to a Sheet on phones; pin the desktop path.
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
}))

const mockedInvoke = vi.mocked(invoke)

const PERSONAL = 'SPACE_PERSONAL'
const LAST_USED = '__last_used__'

const nonEmptyPage = {
  items: [{ id: 'PG_1', block_type: 'page', content: 'a page', parent_id: null }],
  next_cursor: null,
  has_more: false,
  total_count: null,
}

/** The emptiness probe's answer for the seed: only Personal holds pages. */
function probe(args: InvokeArgs | undefined) {
  const { scope } = args as { scope: { space_id: string } }
  return scope.space_id === PERSONAL ? nonEmptyPage : emptyPage
}

function backend(overrides: Record<string, (args: InvokeArgs | undefined) => unknown> = {}) {
  return async (cmd: string, args?: InvokeArgs) => {
    const override = overrides[cmd]
    if (override) return override(args)
    if (cmd === 'list_blocks') return probe(args)
    return dispatch(cmd, args)
  }
}

/** Re-query the in-memory backend. */
function listedSpaces(): SpaceRow[] {
  return dispatch('list_spaces', undefined) as SpaceRow[]
}

let workId: string

beforeEach(async () => {
  vi.clearAllMocks()
  localStorage.clear()
  seedBlocks()
  workId = dispatch('create_space', { name: 'Work', accentColor: null }) as string
  mockedInvoke.mockImplementation(backend())
  useSpaceStore.setState({ currentSpaceId: PERSONAL, availableSpaces: [], isReady: true })
  await useSpaceStore.getState().refreshAvailableSpaces()
})

function deleteButtons(): HTMLElement[] {
  return screen.getAllByRole('button', { name: t('space.deleteSpaceLabel') })
}

function renameInputs(): HTMLInputElement[] {
  return screen.getAllByRole('textbox', { name: t('space.renameLabel') }) as HTMLInputElement[]
}

function row(name: string): HTMLElement {
  const input = renameInputs().find((el) => el.value === name)
  return input?.closest('[data-slot="space-manage-row"]') as HTMLElement
}

async function settleProbes(): Promise<void> {
  await waitFor(() => {
    expect(
      within(row('Work')).getByRole('button', { name: t('space.deleteSpaceLabel') }),
    ).toBeEnabled()
  })
}

describe('SpacesTab', () => {
  it('renders the explanation, the open-on-launch choice and one row per space', async () => {
    render(<SpacesTab />)

    expect(screen.getByText(t('settings.spaces.description'))).toBeInTheDocument()
    const launch = screen.getByRole('combobox', { name: t('settings.spaces.openOnLaunchLabel') })
    expect(launch).toHaveValue(LAST_USED)
    expect(
      within(launch)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([t('settings.spaces.lastUsed'), 'Personal', 'Work'])
    expect(renameInputs().map((input) => input.value)).toEqual(['Personal', 'Work'])
    await settleProbes()
  })

  describe('open on launch', () => {
    it('stores the chosen space for this device without switching to it now', async () => {
      const user = userEvent.setup()
      render(<SpacesTab />)

      await user.selectOptions(
        screen.getByRole('combobox', { name: t('settings.spaces.openOnLaunchLabel') }),
        workId,
      )

      expect(readPreference(PREFERENCES.defaultSpace)).toBe(workId)
      expect(useSpaceStore.getState().currentSpaceId).toBe(PERSONAL)
      await settleProbes()
    })

    it('is what the next launch opens, over the space last used', async () => {
      const user = userEvent.setup()
      const { unmount } = render(<SpacesTab />)
      await user.selectOptions(
        screen.getByRole('combobox', { name: t('settings.spaces.openOnLaunchLabel') }),
        workId,
      )
      await settleProbes()
      unmount()

      // A relaunch: the store starts unready on the persisted space.
      useSpaceStore.setState({ currentSpaceId: PERSONAL, availableSpaces: [], isReady: false })
      await useSpaceStore.getState().refreshAvailableSpaces()

      expect(useSpaceStore.getState().currentSpaceId).toBe(workId)
      render(<SpacesTab />)
      expect(
        screen.getByRole('combobox', { name: t('settings.spaces.openOnLaunchLabel') }),
      ).toHaveValue(workId)
      await settleProbes()
    })

    it('goes back to Last used when chosen', async () => {
      const user = userEvent.setup()
      writePreference(PREFERENCES.defaultSpace, workId)
      render(<SpacesTab />)
      const launch = screen.getByRole('combobox', { name: t('settings.spaces.openOnLaunchLabel') })
      expect(launch).toHaveValue(workId)

      await user.selectOptions(launch, LAST_USED)

      expect(readPreference(PREFERENCES.defaultSpace)).toBeNull()
      expect(launch).toHaveValue(LAST_USED)
      await settleProbes()
    })

    it('goes back to Last used when its space is deleted', async () => {
      const user = userEvent.setup()
      writePreference(PREFERENCES.defaultSpace, workId)
      render(<SpacesTab />)
      await settleProbes()

      await user.click(
        within(row('Work')).getByRole('button', { name: t('space.deleteSpaceLabel') }),
      )
      await user.click(await screen.findByRole('button', { name: t('action.delete') }))

      await waitFor(() => {
        expect(
          screen.getByRole('combobox', { name: t('settings.spaces.openOnLaunchLabel') }),
        ).toHaveValue(LAST_USED)
      })
      expect(readPreference(PREFERENCES.defaultSpace)).toBeNull()
    })
  })

  it('creates a space that the re-queried list carries, accent included', async () => {
    const user = userEvent.setup()
    render(<SpacesTab />)

    await user.click(screen.getByRole('button', { name: t('space.createSpaceLabel') }))
    await user.type(screen.getByPlaceholderText(t('space.newSpacePlaceholder')), 'Side Project')
    const formSwatches = screen.getAllByRole('group', { name: t('space.accentColorLabel') }).at(-1)
    await user.click(
      within(formSwatches as HTMLElement).getByRole('button', {
        name: t('space.accentSwatchLabel', { color: 'blue' }),
      }),
    )
    await user.click(screen.getByRole('button', { name: t('space.createSpaceCta') }))

    expect(await screen.findByDisplayValue('Side Project')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(t('space.newSpacePlaceholder'))).not.toBeInTheDocument()
    expect(listedSpaces().find((s) => s.name === 'Side Project')?.accent_color).toBe('accent-blue')
    await settleProbes()
  })

  it('keeps the form and reports a failed create', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(
      backend({
        create_space: () => {
          throw new Error('IPC offline')
        },
      }),
    )
    render(<SpacesTab />)

    await user.click(screen.getByRole('button', { name: t('space.createSpaceLabel') }))
    await user.type(screen.getByPlaceholderText(t('space.newSpacePlaceholder')), 'Side Project')
    await user.click(screen.getByRole('button', { name: t('space.createSpaceCta') }))

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('space.createSpaceFailed'))
    })
    expect(screen.getByPlaceholderText(t('space.newSpacePlaceholder'))).toHaveValue('Side Project')
    expect(listedSpaces().map((s) => s.name)).toEqual(['Personal', 'Work'])
    await settleProbes()
  })

  it('renames a space, as the re-queried list shows', async () => {
    const user = userEvent.setup()
    render(<SpacesTab />)

    const input = screen.getByDisplayValue('Personal')
    await user.clear(input)
    await user.type(input, 'Home{Enter}')

    await waitFor(() => {
      expect(useSpaceStore.getState().availableSpaces.map((s) => s.name)).toEqual(['Home', 'Work'])
    })
    expect(listedSpaces().map((s) => s.name)).toEqual(['Home', 'Work'])
    expect(screen.getByDisplayValue('Home')).toBeInTheDocument()
  })

  it('restores the name and reports a failed rename', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(
      backend({
        edit_block: () => {
          throw new Error('IPC offline')
        },
      }),
    )
    render(<SpacesTab />)

    const input = screen.getByDisplayValue('Personal')
    await user.clear(input)
    await user.type(input, 'Home{Enter}')

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('space.renameFailed'))
    })
    expect(input).toHaveValue('Personal')
    expect(listedSpaces().map((s) => s.name)).toEqual(['Personal', 'Work'])
  })

  it('recolours a space, as the re-queried list shows', async () => {
    const user = userEvent.setup()
    render(<SpacesTab />)

    await user.click(
      within(row('Work')).getByRole('button', {
        name: t('space.accentSwatchLabel', { color: 'violet' }),
      }),
    )

    await waitFor(() => {
      expect(listedSpaces().find((s) => s.id === workId)?.accent_color).toBe('accent-violet')
    })
    await settleProbes()
  })

  describe('delete', () => {
    it('is disabled, with the reason inline, while the space holds pages', async () => {
      render(<SpacesTab />)
      await settleProbes()

      const personal = row('Personal')
      expect(
        within(personal).getByRole('button', { name: t('space.deleteSpaceLabel') }),
      ).toBeDisabled()
      expect(within(personal).getByTestId('space-delete-blocked-hint')).toHaveTextContent(
        t('space.deleteSpaceInlineHint'),
      )
      expect(within(row('Work')).queryByTestId('space-delete-blocked-hint')).toBeNull()
    })

    it('is disabled on the only space', async () => {
      useSpaceStore.setState({
        availableSpaces: [{ id: workId, name: 'Work', accent_color: null }],
      })
      render(<SpacesTab />)

      // The probe says Work is empty; the last-space guard still wins.
      await waitFor(() => {
        expect(mockedInvoke.mock.calls.some(([cmd]) => cmd === 'list_blocks')).toBe(true)
      })
      await act(async () => {
        await Promise.all(mockedInvoke.mock.results.map((result) => result.value))
      })
      expect(screen.getByRole('button', { name: t('space.deleteSpaceLabel') })).toBeDisabled()
    })

    it('removes an empty space after confirmation, as the re-queried list shows', async () => {
      const user = userEvent.setup()
      render(<SpacesTab />)
      await settleProbes()

      await user.click(
        within(row('Work')).getByRole('button', { name: t('space.deleteSpaceLabel') }),
      )
      expect(
        await screen.findByText(t('space.deleteConfirmTitle', { name: 'Work' })),
      ).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: t('action.delete') }))

      await waitFor(() => {
        expect(renameInputs().map((input) => input.value)).toEqual(['Personal'])
      })
      expect(listedSpaces().map((s) => s.name)).toEqual(['Personal'])
    })
  })

  // ── the per-space emptiness probe ──────────────────────────────────────

  it('fires the emptiness probe once per space', async () => {
    render(<SpacesTab />)
    await settleProbes()

    const probed = mockedInvoke.mock.calls
      .filter(([cmd]) => cmd === 'list_blocks')
      .map(([, args]) => (args as { scope: { space_id: string } }).scope.space_id)
    expect(probed.toSorted()).toEqual([PERSONAL, workId].toSorted())
  })

  it('re-reads emptiness on every visit (#5284)', async () => {
    let personalPage: typeof emptyPage | typeof nonEmptyPage = nonEmptyPage
    mockedInvoke.mockImplementation(backend({ list_blocks: () => personalPage }))

    const { unmount } = render(<SpacesTab />)
    await waitFor(() => {
      expect(screen.getAllByTestId('space-delete-blocked-hint')).toHaveLength(2)
    })
    unmount()
    // Between visits, the spaces' pages move out.
    personalPage = emptyPage

    render(<SpacesTab />)
    await waitFor(() => {
      for (const btn of deleteButtons()) expect(btn).toBeEnabled()
    })
  })

  it('keeps a probe result that lands after the space list changed (#5284)', async () => {
    const pending: Array<(v: unknown) => void> = []
    mockedInvoke.mockImplementation(
      backend({ list_blocks: () => new Promise((resolve) => pending.push(resolve)) }),
    )

    render(<SpacesTab />)
    await waitFor(() => expect(pending).toHaveLength(2))

    // A refresh lands while both probes are in flight.
    act(() => {
      useSpaceStore.setState({
        availableSpaces: [
          ...useSpaceStore.getState().availableSpaces,
          { id: 'SPACE_3', name: 'Side', accent_color: null },
        ],
      })
    })
    await waitFor(() => expect(pending).toHaveLength(3))
    await act(async () => {
      for (const resolve of pending) resolve(emptyPage)
    })

    await waitFor(() => {
      expect(deleteButtons()).toHaveLength(3)
      for (const btn of deleteButtons()) expect(btn).toBeEnabled()
    })
  })

  it('drops a probe that resolves after the tab unmounted (B-7)', async () => {
    let resolveProbe!: (v: unknown) => void
    mockedInvoke.mockImplementation(
      backend({
        list_blocks: () =>
          new Promise((resolve) => {
            resolveProbe = resolve
          }),
      }),
    )
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { unmount } = render(<SpacesTab />)
    await waitFor(() => {
      expect(mockedInvoke.mock.calls.some(([cmd]) => cmd === 'list_blocks')).toBe(true)
    })
    unmount()
    await act(async () => {
      resolveProbe(emptyPage)
    })

    expect(vi.mocked(logger.warn)).not.toHaveBeenCalledWith(
      expect.any(String),
      'failed to probe space emptiness',
      expect.anything(),
      expect.anything(),
    )
    expect(consoleErrorSpy).not.toHaveBeenCalled()
    consoleErrorSpy.mockRestore()
  })

  it('keeps Delete disabled and logs when the probe fails', async () => {
    mockedInvoke.mockImplementation(
      backend({
        list_blocks: () => {
          throw new Error('IPC offline')
        },
      }),
    )
    render(<SpacesTab />)

    await waitFor(() => {
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'components/settings/SpacesTab',
        'failed to probe space emptiness',
        expect.anything(),
        expect.any(Error),
      )
    })
    for (const btn of deleteButtons()) expect(btn).toBeDisabled()
  })

  // ── accessibility ──────────────────────────────────────────────────────

  it('has no a11y violations', async () => {
    const { container } = render(<SpacesTab />)
    await settleProbes()
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })

  it('has no a11y violations with the create form open', async () => {
    const user = userEvent.setup()
    const { container } = render(<SpacesTab />)
    await settleProbes()
    await user.click(screen.getByRole('button', { name: t('space.createSpaceLabel') }))
    await screen.findByPlaceholderText(t('space.newSpacePlaceholder'))
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })

  it('has no a11y violations with the delete confirmation open', async () => {
    const user = userEvent.setup()
    const { container } = render(<SpacesTab />)
    await settleProbes()
    await user.click(within(row('Work')).getByRole('button', { name: t('space.deleteSpaceLabel') }))
    await screen.findByText(t('space.deleteConfirmTitle', { name: 'Work' }))
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
