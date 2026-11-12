/**
 * Tests for MirrorSection — the Markdown mirror card in Settings › Data (#5363).
 *
 * The three mirror commands are stubbed over one in-memory folder, so the
 * assertions read what `get_mirror_status` answers after an interaction, not
 * only what was asked for.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { stubInvoke } from '@/__tests__/helpers/invoke'
import { MirrorSection } from '@/components/settings/MirrorSection'
import type { AppError, MirrorStatus } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { useSpaceStore } from '@/stores/space'

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const PICKED = '/home/me/Notes mirror'

const SPACES = [
  { id: 'SPACE_PERSONAL', name: 'Personal', accent_color: null },
  { id: 'SPACE_WORK', name: 'Work', accent_color: null },
] as unknown as ReturnType<typeof useSpaceStore.getState>['availableSpaces']

const refusedTurnOn: AppError = {
  kind: 'validation',
  message: '1 files changed outside Agaric while reading back was off',
}

/** The device-local state the stubbed commands read and write. */
let folder: string | null
let picked: string | null
let readBack: boolean
let pendingFiles: string[]
let unmirrored: string[]
let extra: Partial<MirrorStatus>

function status(): MirrorStatus {
  return {
    supported: true,
    folder,
    paused: null,
    diverged: [],
    failed: [],
    last_pass_ms: null,
    read_back: readBack,
    pending: readBack ? [] : pendingFiles,
    copy_files: false,
    unmirrored_spaces: unmirrored,
    ...extra,
  }
}

async function storedStatus(): Promise<MirrorStatus> {
  const result = await commands.getMirrorStatus()
  if (result.status !== 'ok') throw new Error('get_mirror_status failed')
  return result.data
}

beforeEach(() => {
  vi.clearAllMocks()
  folder = null
  picked = PICKED
  readBack = true
  pendingFiles = []
  unmirrored = []
  extra = {}
  useSpaceStore.setState({ availableSpaces: [] })
  stubInvoke(vi.mocked(invoke), {
    get_mirror_status: () => status(),
    pick_mirror_folder: () => picked,
    set_mirror_folder: (args) => {
      const wasOn = folder !== null
      folder = args['path'] as string | null
      // Taken only when the mirror turns on, as the backend takes it.
      if (folder !== null && !wasOn) readBack = args['readBack'] as boolean
      return status()
    },
    set_mirror_space: (args) => {
      const id = args['spaceId'] as string
      unmirrored = unmirrored.filter((space) => space !== id)
      if (args['mirrored'] !== true) unmirrored.push(id)
      return status()
    },
    set_mirror_read_back: (args) => {
      const confirmed = args['confirmed'] as string[]
      if (args['on'] === true && pendingFiles.some((path) => !confirmed.includes(path))) {
        return Promise.reject(refusedTurnOn)
      }
      readBack = args['on'] as boolean
      if (readBack) pendingFiles = []
      return status()
    },
  })
})

async function renderLoaded() {
  const result = render(<MirrorSection />)
  expect(await screen.findByText(t('data.mirrorTitle'))).toBeInTheDocument()
  return result
}

describe('MirrorSection', () => {
  it('shows that the mirror is off, with what it does', async () => {
    await renderLoaded()

    expect(screen.getByText(t('data.mirrorDesc'))).toBeInTheDocument()
    expect(screen.getByText(t('data.mirrorOff'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('data.mirrorChooseButton') })).toBeEnabled()
    expect(screen.queryByRole('button', { name: t('data.mirrorTurnOffButton') })).toBeNull()
  })

  it('Choose folder picks a folder, sets it, and shows it', async () => {
    const user = userEvent.setup()
    await renderLoaded()

    await user.click(screen.getByRole('button', { name: t('data.mirrorChooseButton') }))

    expect(await screen.findByText(PICKED)).toBeInTheDocument()
    expect(screen.queryByText(t('data.mirrorOff'))).toBeNull()
    expect((await storedStatus()).folder).toBe(PICKED)
  })

  it('a cancelled pick changes nothing', async () => {
    picked = null
    const user = userEvent.setup()
    await renderLoaded()

    await user.click(screen.getByRole('button', { name: t('data.mirrorChooseButton') }))

    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('pick_mirror_folder')
    })
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith('set_mirror_folder', expect.anything())
    expect(screen.getByText(t('data.mirrorOff'))).toBeInTheDocument()
    expect((await storedStatus()).folder).toBeNull()
  })

  it('Turn off clears the folder', async () => {
    folder = PICKED
    const user = userEvent.setup()
    await renderLoaded()
    expect(screen.getByText(PICKED)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: t('data.mirrorTurnOffButton') }))

    expect(await screen.findByText(t('data.mirrorOff'))).toBeInTheDocument()
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('set_mirror_folder', {
      path: null,
      readBack: true,
    })
    expect((await storedStatus()).folder).toBeNull()
  })

  it('lists files changed outside Agaric, failures and the paused reason', async () => {
    folder = PICKED
    extra = {
      paused: 'the mirror folder is missing',
      diverged: [{ page_id: 'P1', path: 'Personal/Projects.md' }],
      failed: [{ page_id: 'P2', path: 'Personal/Meetings.md', message: 'permission denied' }],
    }
    await renderLoaded()

    expect(
      screen.getByText(t('data.mirrorPaused', { reason: 'the mirror folder is missing' })),
    ).toBeInTheDocument()
    const diverged = screen.getByRole('list', { name: t('data.mirrorDivergedHeading') })
    expect(diverged).toHaveTextContent('Personal/Projects.md')
    const failed = screen.getByRole('list', { name: t('data.mirrorFailedHeading') })
    expect(failed).toHaveTextContent(
      t('data.mirrorFailedItem', { path: 'Personal/Meetings.md', message: 'permission denied' }),
    )
    expect(screen.queryByText(t('data.mirrorDivergedNone'))).toBeNull()
  })

  it('says so when no file has changed outside Agaric', async () => {
    folder = PICKED
    await renderLoaded()

    expect(screen.getByText(t('data.mirrorDivergedNone'))).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: t('data.mirrorFailedHeading') })).toBeNull()
  })

  it('renders nothing where the mirror is not supported', async () => {
    extra = { supported: false }
    const { container } = render(<MirrorSection />)

    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('get_mirror_status')
    })
    expect(container).toBeEmptyDOMElement()
  })

  it('a refused folder shows the reason, logs it, and keeps the mirror off', async () => {
    const refusal: AppError = {
      kind: 'validation',
      message: 'the folder is not empty and Agaric did not create it',
    }
    stubInvoke(vi.mocked(invoke), {
      get_mirror_status: () => status(),
      pick_mirror_folder: () => picked,
      set_mirror_folder: () => Promise.reject(refusal),
    })
    const user = userEvent.setup()
    await renderLoaded()

    await user.click(screen.getByRole('button', { name: t('data.mirrorChooseButton') }))

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        t('data.mirrorFailed', { reason: refusal.message }),
      )
    })
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'MirrorSection',
      'failed to change the mirror folder',
      undefined,
      refusal,
    )
    expect(screen.getByText(t('data.mirrorOff'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('data.mirrorChooseButton') })).toBeEnabled()
    expect((await storedStatus()).folder).toBeNull()
  })

  it('a folder chosen with reading back unticked is mirrored without reading back', async () => {
    const user = userEvent.setup()
    await renderLoaded()
    const toggle = screen.getByRole('switch', { name: t('data.mirrorReadBackLabel') })
    expect(toggle).toBeChecked()

    await user.click(toggle)
    await user.click(screen.getByRole('button', { name: t('data.mirrorChooseButton') }))

    expect(await screen.findByText(PICKED)).toBeInTheDocument()
    const stored = await storedStatus()
    expect(stored.folder).toBe(PICKED)
    expect(stored.read_back).toBe(false)
    expect(screen.getByRole('switch', { name: t('data.mirrorReadBackLabel') })).not.toBeChecked()
  })

  it('choosing a folder while mirroring with reading back off keeps it off', async () => {
    folder = PICKED
    readBack = false
    const user = userEvent.setup()
    await renderLoaded()

    await user.click(screen.getByRole('button', { name: t('data.mirrorChooseButton') }))

    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('set_mirror_folder', expect.anything())
    })
    expect((await storedStatus()).read_back).toBe(false)
    expect(screen.getByRole('switch', { name: t('data.mirrorReadBackLabel') })).not.toBeChecked()
  })

  it('turning reading back off and on again with nothing pending asks nothing', async () => {
    folder = PICKED
    const user = userEvent.setup()
    await renderLoaded()

    await user.click(screen.getByRole('switch', { name: t('data.mirrorReadBackLabel') }))
    await waitFor(async () => {
      expect((await storedStatus()).read_back).toBe(false)
    })
    await user.click(screen.getByRole('switch', { name: t('data.mirrorReadBackLabel') }))

    await waitFor(async () => {
      expect((await storedStatus()).read_back).toBe(true)
    })
    expect(screen.queryByText(t('data.mirrorReadPendingTitle'))).toBeNull()
  })

  it('turning reading back on with files pending lists them and reads them in only on confirm', async () => {
    folder = PICKED
    readBack = false
    pendingFiles = ['Personal/Projects.md']
    const user = userEvent.setup()
    await renderLoaded()

    await user.click(screen.getByRole('switch', { name: t('data.mirrorReadBackLabel') }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Personal/Projects.md')
    expect(dialog).toHaveTextContent(t('data.mirrorReadPendingDesc', { count: 1 }))
    await user.click(screen.getByRole('button', { name: t('data.mirrorReadPendingCancel') }))
    expect((await storedStatus()).read_back).toBe(false)

    await user.click(screen.getByRole('switch', { name: t('data.mirrorReadBackLabel') }))
    await user.click(
      await screen.findByRole('button', { name: t('data.mirrorReadPendingConfirm') }),
    )

    await waitFor(async () => {
      expect((await storedStatus()).read_back).toBe(true)
    })
    expect(screen.getByRole('switch', { name: t('data.mirrorReadBackLabel') })).toBeChecked()
  })

  it('a turn-on the backend refuses, as files changed since the card loaded, says why', async () => {
    folder = PICKED
    readBack = false
    const user = userEvent.setup()
    await renderLoaded()
    pendingFiles = ['Personal/Projects.md']

    await user.click(screen.getByRole('switch', { name: t('data.mirrorReadBackLabel') }))

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        t('data.mirrorReadBackFailed', { reason: refusedTurnOn.message }),
      )
    })
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'MirrorSection',
      'failed to change reading changes back',
      undefined,
      refusedTurnOn,
    )
    expect((await storedStatus()).read_back).toBe(false)
    expect(screen.getByRole('switch', { name: t('data.mirrorReadBackLabel') })).not.toBeChecked()

    // The card read the status again, so the next try asks about the file.
    await user.click(screen.getByRole('switch', { name: t('data.mirrorReadBackLabel') }))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Personal/Projects.md')
  })

  it('confirming a list a later change made stale reads nothing in and asks again', async () => {
    folder = PICKED
    readBack = false
    pendingFiles = ['Personal/Projects.md']
    const user = userEvent.setup()
    await renderLoaded()
    await user.click(screen.getByRole('switch', { name: t('data.mirrorReadBackLabel') }))
    await screen.findByRole('alertdialog')
    pendingFiles = ['Personal/Projects.md', 'Personal/Unseen.md']

    await user.click(screen.getByRole('button', { name: t('data.mirrorReadPendingConfirm') }))

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        t('data.mirrorReadBackFailed', { reason: refusedTurnOn.message }),
      )
    })
    // It confirmed what it showed, not whatever is pending by now.
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('set_mirror_read_back', {
      on: true,
      confirmed: ['Personal/Projects.md'],
    })
    expect((await storedStatus()).read_back).toBe(false)
    await user.click(screen.getByRole('switch', { name: t('data.mirrorReadBackLabel') }))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Personal/Unseen.md')
  })

  it('has no a11y violations with the read-in question open', async () => {
    folder = PICKED
    readBack = false
    pendingFiles = ['Personal/Projects.md']
    const user = userEvent.setup()
    const { baseElement } = await renderLoaded()
    await user.click(screen.getByRole('switch', { name: t('data.mirrorReadBackLabel') }))
    await screen.findByRole('alertdialog')

    await waitFor(async () => {
      expect(await axe(baseElement)).toHaveNoViolations()
    })
  })

  it('lists each space with a switch, and turning one off keeps the others mirrored', async () => {
    useSpaceStore.setState({ availableSpaces: SPACES })
    folder = PICKED
    const user = userEvent.setup()
    await renderLoaded()

    const personal = screen.getByRole('switch', { name: 'Personal' })
    const work = screen.getByRole('switch', { name: 'Work' })
    expect(personal).toBeChecked()
    expect(work).toBeChecked()
    await user.click(work)

    await waitFor(async () => {
      expect((await storedStatus()).unmirrored_spaces).toEqual(['SPACE_WORK'])
    })
    expect(screen.getByRole('switch', { name: 'Work' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'Personal' })).toBeChecked()

    await user.click(screen.getByRole('switch', { name: 'Work' }))
    await waitFor(async () => {
      expect((await storedStatus()).unmirrored_spaces).toEqual([])
    })
  })

  it('a refused space change says why and keeps the switch as it was', async () => {
    useSpaceStore.setState({ availableSpaces: SPACES })
    folder = PICKED
    const refusal: AppError = { kind: 'validation', message: 'no space SPACE_WORK' }
    stubInvoke(vi.mocked(invoke), {
      get_mirror_status: () => status(),
      set_mirror_space: () => Promise.reject(refusal),
    })
    const user = userEvent.setup()
    await renderLoaded()

    await user.click(screen.getByRole('switch', { name: 'Work' }))

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        t('data.mirrorSpaceFailed', { reason: refusal.message }),
      )
    })
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'MirrorSection',
      'failed to change which spaces are mirrored',
      undefined,
      refusal,
    )
    expect(screen.getByRole('switch', { name: 'Work' })).toBeChecked()
  })

  it('has no a11y violations with the spaces listed', async () => {
    useSpaceStore.setState({ availableSpaces: SPACES })
    folder = PICKED
    unmirrored = ['SPACE_WORK']
    const { container } = await renderLoaded()
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })

  it('has no a11y violations, off and on', async () => {
    const { container, unmount } = await renderLoaded()
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
    unmount()

    folder = PICKED
    extra = { diverged: [{ page_id: 'P1', path: 'Personal/Projects.md' }] }
    const on = await renderLoaded()
    await waitFor(async () => {
      expect(await axe(on.container)).toHaveNoViolations()
    })
  })
})
