/**
 * Tests for MirrorSection — the Markdown mirror card in Settings › Data (#5363).
 *
 * The three mirror commands are stubbed over one in-memory folder, so the
 * assertions read what `get_mirror_status` answers after an interaction, not
 * only what was asked for.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { stubInvoke } from '@/__tests__/helpers/invoke'
import { MirrorSection } from '@/components/settings/MirrorSection'
import { MIRROR_HELD_EVENT, MIRROR_INGESTED_EVENT } from '@/hooks/useMirrorIngestEvents'
import type { AppError, MirrorPending, MirrorPendingKind, MirrorStatus } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { useSpaceStore } from '@/stores/space'

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const eventListeners = new Map<string, (event: unknown) => void>()

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (eventName: string, handler: (event: unknown) => void): Promise<() => void> => {
      eventListeners.set(eventName, handler)
      return () => {
        eventListeners.delete(eventName)
      }
    },
  ),
}))

const PICKED = '/home/me/Notes mirror'

// The card listens for read-backs only inside Tauri.
const tauriWindow = window as { __TAURI_INTERNALS__?: unknown }
const hadTauriInternals = '__TAURI_INTERNALS__' in window
afterEach(() => {
  if (!hadTauriInternals) delete tauriWindow.__TAURI_INTERNALS__
})

const SPACES = [
  { id: 'SPACE_PERSONAL', name: 'Personal', accent_color: null },
  { id: 'SPACE_WORK', name: 'Work', accent_color: null },
] as unknown as ReturnType<typeof useSpaceStore.getState>['availableSpaces']

const refusedTurnOn: AppError = {
  kind: 'validation',
  message: '1 files changed outside Agaric have not been shown',
}

/** The device-local state the stubbed commands read and write. */
let folder: string | null
let picked: string | null
let readBack: boolean
let copyFiles: boolean
let askMassChange: boolean
/** The space folders whose many changed files hold reading back. */
let held: string[]
let pendingFiles: string[]
/** What reading each pending file in does; edited unless named here. */
let pendingKinds: Record<string, MirrorPendingKind>
let unmirrored: string[]
let extra: Partial<MirrorStatus>
/** Why `get_mirror_status` is refused, while it is. */
let statusRefused: AppError | null

const HOLD_REASON = '6 of its files changed or vanished outside Agaric at once, more than 5'

function pendingNow(): MirrorPending[] {
  return pendingFiles.map((path) => ({ path, kind: pendingKinds[path] ?? 'edited' }))
}

function status(): MirrorStatus {
  // A hold reports reading back off, as the backend does, while it stays stored on.
  const reading = readBack && held.length === 0
  return {
    supported: true,
    folder,
    paused: null,
    diverged: [],
    failed: held.map((path) => ({ page_id: '', path, message: HOLD_REASON })),
    last_pass_ms: null,
    read_back: reading,
    pending: reading ? [] : pendingNow(),
    copy_files: copyFiles,
    ask_mass_change: askMassChange,
    held,
    unmirrored_spaces: unmirrored,
    adopted_space: null,
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
  copyFiles = false
  askMassChange = true
  held = []
  pendingFiles = []
  pendingKinds = {}
  unmirrored = []
  extra = {}
  statusRefused = null
  tauriWindow.__TAURI_INTERNALS__ = {}
  useSpaceStore.setState({ availableSpaces: [] })
  stubInvoke(vi.mocked(invoke), {
    get_mirror_status: () => (statusRefused === null ? status() : Promise.reject(statusRefused)),
    pick_mirror_folder: () => picked,
    set_mirror_folder: (args) => {
      const wasOn = folder !== null
      folder = args['path'] as string | null
      // Taken only when the mirror turns on, as the backend takes it, which
      // holds it off while the folder holds changed files.
      if (folder !== null && !wasOn) {
        readBack = (args['readBack'] as boolean) && pendingFiles.length === 0
      }
      return status()
    },
    set_mirror_space: (args) => {
      const id = args['spaceId'] as string
      unmirrored = unmirrored.filter((space) => space !== id)
      if (args['mirrored'] !== true) unmirrored.push(id)
      return status()
    },
    set_mirror_read_back: (args) => {
      const confirmed = args['confirmed'] as MirrorPending[]
      // As the backend: a pending file is confirmed only as it was shown.
      const shown = (file: MirrorPending) =>
        confirmed.some((seen) => seen.path === file.path && seen.kind === file.kind)
      if (args['on'] === true && !pendingNow().every(shown)) {
        return Promise.reject(refusedTurnOn)
      }
      readBack = args['on'] as boolean
      if (readBack) pendingFiles = []
      held = []
      return status()
    },
    set_mirror_copy_files: (args) => {
      copyFiles = args['on'] as boolean
      return status()
    },
    set_mirror_ask_mass_change: (args) => {
      askMassChange = args['on'] as boolean
      // Off, a hold shown ends at once, as the backend ends it.
      if (!askMassChange) held = []
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

  // #6520 — a phone is a full peer: the card stays and says why it cannot run there.
  it('says why it cannot run where the mirror is not supported, and offers no folder picker', async () => {
    extra = { supported: false }
    const { container } = render(<MirrorSection />)

    expect(await screen.findByText(t('data.mirrorUnsupported'))).toBeInTheDocument()
    expect(screen.getByTestId('mirror-panel-title')).toHaveTextContent(t('data.mirrorTitle'))
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(await axe(container)).toHaveNoViolations()
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

  it('with the mirror off, the stored reading back shows and goes with the folder chosen', async () => {
    readBack = false
    const user = userEvent.setup()
    await renderLoaded()
    expect(screen.getByRole('switch', { name: t('data.mirrorReadBackLabel') })).not.toBeChecked()

    await user.click(screen.getByRole('button', { name: t('data.mirrorChooseButton') }))

    expect(await screen.findByText(PICKED)).toBeInTheDocument()
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('set_mirror_folder', {
      path: PICKED,
      readBack: false,
    })
    expect((await storedStatus()).read_back).toBe(false)
  })

  it('a folder chosen holding changed files asks before reading them in', async () => {
    pendingFiles = ['Personal/Projects.md']
    const user = userEvent.setup()
    await renderLoaded()

    await user.click(screen.getByRole('button', { name: t('data.mirrorChooseButton') }))

    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Personal/Projects.md')
    expect((await storedStatus()).read_back).toBe(false)
    await user.click(screen.getByRole('button', { name: t('data.mirrorReadPendingConfirm') }))
    await waitFor(async () => {
      expect((await storedStatus()).read_back).toBe(true)
    })
  })

  it('a folder chosen holding changed files with reading back off asks nothing', async () => {
    readBack = false
    pendingFiles = ['Personal/Projects.md']
    const user = userEvent.setup()
    await renderLoaded()

    await user.click(screen.getByRole('button', { name: t('data.mirrorChooseButton') }))

    expect(await screen.findByText(PICKED)).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('Turn off keeps reading back as it was', async () => {
    folder = PICKED
    readBack = false
    const user = userEvent.setup()
    await renderLoaded()

    await user.click(screen.getByRole('button', { name: t('data.mirrorTurnOffButton') }))

    expect(await screen.findByText(t('data.mirrorOff'))).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: t('data.mirrorReadBackLabel') })).not.toBeChecked()
  })

  it('choosing a folder while mirroring with reading back off keeps it off', async () => {
    folder = PICKED
    readBack = false
    const user = userEvent.setup()
    await renderLoaded()

    await user.click(screen.getByRole('button', { name: t('data.mirrorChooseButton') }))

    await waitFor(async () => {
      expect((await storedStatus()).read_back).toBe(false)
    })
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

  it('the copy switch turns copying attachments on and off', async () => {
    folder = PICKED
    const user = userEvent.setup()
    await renderLoaded()
    const copy = screen.getByRole('switch', { name: t('data.mirrorCopyFilesLabel') })
    expect(copy).not.toBeChecked()

    await user.click(copy)
    await waitFor(() => {
      expect(copy).toBeChecked()
    })
    expect((await storedStatus()).copy_files).toBe(true)

    await user.click(copy)
    await waitFor(() => {
      expect(copy).not.toBeChecked()
    })
    expect((await storedStatus()).copy_files).toBe(false)
  })

  it('a copy switch the backend refuses says why and stays as it was', async () => {
    const refused: AppError = { kind: 'io', message: 'disk full' }
    vi.mocked(invoke).mockImplementation((cmd: string) =>
      cmd === 'set_mirror_copy_files' ? Promise.reject(refused) : Promise.resolve(status()),
    )
    const user = userEvent.setup()
    await renderLoaded()

    await user.click(screen.getByRole('switch', { name: t('data.mirrorCopyFilesLabel') }))

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        t('data.mirrorCopyFilesFailed', { reason: refused.message }),
      )
    })
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'MirrorSection',
      'failed to change copying attachments',
      undefined,
      refused,
    )
    expect(screen.getByRole('switch', { name: t('data.mirrorCopyFilesLabel') })).not.toBeChecked()
    expect((await storedStatus()).copy_files).toBe(false)
  })

  it('the ask switch is on by default and turns asking before many changes off and on', async () => {
    folder = PICKED
    const user = userEvent.setup()
    await renderLoaded()
    const ask = screen.getByRole('switch', { name: t('data.mirrorAskMassChangeLabel') })
    expect(ask).toBeChecked()

    await user.click(ask)
    await waitFor(() => {
      expect(ask).not.toBeChecked()
    })
    expect((await storedStatus()).ask_mass_change).toBe(false)

    await user.click(ask)
    await waitFor(() => {
      expect(ask).toBeChecked()
    })
    expect((await storedStatus()).ask_mass_change).toBe(true)
  })

  it('an ask switch the backend refuses says why and stays as it was', async () => {
    const refused: AppError = { kind: 'io', message: 'disk full' }
    vi.mocked(invoke).mockImplementation((cmd: string) =>
      cmd === 'set_mirror_ask_mass_change' ? Promise.reject(refused) : Promise.resolve(status()),
    )
    const user = userEvent.setup()
    await renderLoaded()

    await user.click(screen.getByRole('switch', { name: t('data.mirrorAskMassChangeLabel') }))

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        t('data.mirrorAskMassChangeFailed', { reason: refused.message }),
      )
    })
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'MirrorSection',
      'failed to change asking before many changes',
      undefined,
      refused,
    )
    expect(screen.getByRole('switch', { name: t('data.mirrorAskMassChangeLabel') })).toBeChecked()
    expect((await storedStatus()).ask_mass_change).toBe(true)
  })

  it('a hold shows a button beside its line that moves to the ask switch', async () => {
    folder = PICKED
    held = ['Personal']
    pendingFiles = ['Personal/A.md', 'Personal/B.md']
    extra = {
      failed: [
        { page_id: '', path: 'Personal', message: HOLD_REASON },
        { page_id: '', path: 'loose.md', message: 'files are read only inside a space folder' },
      ],
    }
    const user = userEvent.setup()
    await renderLoaded()
    const failed = screen.getByRole('list', { name: t('data.mirrorFailedHeading') })
    const [holdLine, otherLine] = within(failed).getAllByRole('listitem')
    expect(holdLine).toHaveTextContent(HOLD_REASON)
    expect(within(otherLine as HTMLElement).queryByRole('button')).toBeNull()

    await user.click(
      within(holdLine as HTMLElement).getByRole('button', {
        name: t('data.mirrorMassChangeShowSetting'),
      }),
    )

    expect(screen.getByRole('switch', { name: t('data.mirrorAskMassChangeLabel') })).toHaveFocus()
  })

  it('the read-in question for a hold says why, and its button moves to the ask switch', async () => {
    folder = PICKED
    held = ['Personal']
    pendingFiles = ['Personal/A.md', 'Personal/B.md']
    const user = userEvent.setup()
    await renderLoaded()

    await user.click(screen.getByRole('switch', { name: t('data.mirrorReadBackLabel') }))
    const question = await screen.findByRole('alertdialog')
    expect(question).toHaveTextContent(t('data.mirrorReadMassChangeDesc'))
    expect(question).toHaveTextContent(t('data.mirrorMassChangeTurnOff'))
    expect(question).toHaveTextContent('Personal/B.md')
    await user.click(
      within(question).getByRole('button', { name: t('data.mirrorMassChangeShowSetting') }),
    )

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: t('data.mirrorAskMassChangeLabel') })).toHaveFocus()
    })
    expect((await storedStatus()).read_back).toBe(false)

    // Asked again and kept off, focus goes back to what asked, not to the ask switch.
    const readBackSwitch = screen.getByRole('switch', { name: t('data.mirrorReadBackLabel') })
    await user.click(readBackSwitch)
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: t('data.mirrorReadPendingCancel'),
      }),
    )
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })
    await waitFor(() => {
      expect(readBackSwitch).toHaveFocus()
    })
  })

  it('turning asking off ends a hold shown, and its button goes', async () => {
    folder = PICKED
    held = ['Personal']
    pendingFiles = ['Personal/A.md']
    const user = userEvent.setup()
    await renderLoaded()
    expect(screen.getByRole('switch', { name: t('data.mirrorReadBackLabel') })).not.toBeChecked()
    expect(
      screen.getByRole('button', { name: t('data.mirrorMassChangeShowSetting') }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('switch', { name: t('data.mirrorAskMassChangeLabel') }))

    await waitFor(() => {
      expect(screen.getByRole('switch', { name: t('data.mirrorReadBackLabel') })).toBeChecked()
    })
    expect(screen.queryByRole('button', { name: t('data.mirrorMassChangeShowSetting') })).toBeNull()
    expect((await storedStatus()).held).toEqual([])
  })

  it('has no a11y violations with a hold shown and its question open', async () => {
    folder = PICKED
    held = ['Personal']
    pendingFiles = ['Personal/A.md']
    const user = userEvent.setup()
    const { baseElement, container } = await renderLoaded()
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })

    await user.click(screen.getByRole('switch', { name: t('data.mirrorReadBackLabel') }))
    await screen.findByRole('alertdialog')
    await waitFor(async () => {
      expect(await axe(baseElement)).toHaveNoViolations()
    })
  })

  it('lists files no page owns, such as kept copies, one row each', async () => {
    folder = PICKED
    const keys = vi.spyOn(console, 'error').mockImplementation(() => {})
    extra = {
      diverged: [
        { page_id: '', path: 'Personal/assets/A1/cat.png' },
        { page_id: '', path: 'Personal/assets/A2/dog.png' },
      ],
      failed: [
        { page_id: '', path: 'Personal/assets/A3/a.png', message: 'denied' },
        { page_id: '', path: 'Personal/assets/A4/b.png', message: 'denied' },
      ],
    }
    await renderLoaded()

    const diverged = screen.getByRole('list', { name: t('data.mirrorDivergedHeading') })
    expect(diverged.querySelectorAll('li')).toHaveLength(2)
    const failed = screen.getByRole('list', { name: t('data.mirrorFailedHeading') })
    expect(failed.querySelectorAll('li')).toHaveLength(2)
    expect(keys).not.toHaveBeenCalledWith(expect.stringContaining('same key'), expect.anything())
    keys.mockRestore()
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
      confirmed: [{ path: 'Personal/Projects.md', kind: 'edited' }],
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

  // #6887 F — the question groups the files by what reading them in does.
  it('the read-in question lists the files edited, new and gone under their own headings', async () => {
    folder = PICKED
    readBack = false
    pendingFiles = ['Personal/Edited.md', 'Personal/New.md', 'Personal/Gone.md']
    pendingKinds = { 'Personal/New.md': 'new', 'Personal/Gone.md': 'gone' }
    const user = userEvent.setup()
    await renderLoaded()

    await user.click(screen.getByRole('switch', { name: t('data.mirrorReadBackLabel') }))
    const dialog = await screen.findByRole('alertdialog')
    const group = (key: string) =>
      within(dialog)
        .getByRole('list', { name: t(key) })
        .querySelectorAll('li')
    expect([...group('data.mirrorPendingEdited')].map((li) => li.textContent)).toEqual([
      'Personal/Edited.md',
    ])
    expect([...group('data.mirrorPendingNew')].map((li) => li.textContent)).toEqual([
      'Personal/New.md',
    ])
    expect([...group('data.mirrorPendingGone')].map((li) => li.textContent)).toEqual([
      'Personal/Gone.md',
    ])

    await user.click(screen.getByRole('button', { name: t('data.mirrorReadPendingConfirm') }))
    await waitFor(async () => {
      expect((await storedStatus()).read_back).toBe(true)
    })
  })

  it('the read-in question shows no heading for a kind no file has', async () => {
    folder = PICKED
    readBack = false
    pendingFiles = ['Personal/Gone.md']
    pendingKinds = { 'Personal/Gone.md': 'gone' }
    const user = userEvent.setup()
    await renderLoaded()

    await user.click(screen.getByRole('switch', { name: t('data.mirrorReadBackLabel') }))
    const dialog = await screen.findByRole('alertdialog')

    expect(
      within(dialog).getByRole('list', { name: t('data.mirrorPendingGone') }),
    ).toHaveTextContent('Personal/Gone.md')
    expect(within(dialog).queryByText(t('data.mirrorPendingEdited'))).toBeNull()
    expect(within(dialog).queryByText(t('data.mirrorPendingNew'))).toBeNull()
  })

  // #6887 E — what a tick read back shows without reopening Settings.
  it('reads its status again when a file is read back from the folder', async () => {
    folder = PICKED
    await renderLoaded()
    expect(screen.getByText(t('data.mirrorDivergedNone'))).toBeInTheDocument()
    extra = { failed: [{ page_id: '', path: 'Personal/New.md', message: 'not UTF-8' }] }

    await waitFor(() => expect(eventListeners.has(MIRROR_INGESTED_EVENT)).toBe(true))
    eventListeners.get(MIRROR_INGESTED_EVENT)?.({ payload: {} })

    expect(
      await screen.findByText(
        t('data.mirrorFailedItem', { path: 'Personal/New.md', message: 'not UTF-8' }),
      ),
    ).toBeInTheDocument()
  })

  // #6964 — a hold a tick starts shows without reopening Settings.
  it('reads its status again when a tick holds reading back', async () => {
    folder = PICKED
    await renderLoaded()
    expect(screen.queryByRole('button', { name: t('data.mirrorMassChangeShowSetting') })).toBeNull()
    held = ['Personal']
    pendingFiles = ['Personal/A.md']
    extra = { failed: [{ page_id: '', path: 'Personal', message: HOLD_REASON }] }

    await waitFor(() => expect(eventListeners.has(MIRROR_HELD_EVENT)).toBe(true))
    eventListeners.get(MIRROR_HELD_EVENT)?.({ payload: ['Personal'] })

    expect(
      await screen.findByRole('button', { name: t('data.mirrorMassChangeShowSetting') }),
    ).toBeInTheDocument()
  })

  it('a status read again on a read-back that fails keeps the card and logs why', async () => {
    folder = PICKED
    await renderLoaded()
    const refused: AppError = { kind: 'io', message: 'disk gone' }
    statusRefused = refused

    await waitFor(() => expect(eventListeners.has(MIRROR_INGESTED_EVENT)).toBe(true))
    eventListeners.get(MIRROR_INGESTED_EVENT)?.({ payload: {} })

    await waitFor(() => {
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'MirrorSection',
        'failed to load the mirror status; hiding the card',
        undefined,
        refused,
      )
    })
    expect(screen.getByTestId('mirror-folder')).toHaveTextContent(PICKED)
  })
})
