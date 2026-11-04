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

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const PICKED = '/home/me/Notes mirror'

/** The device-local state the stubbed commands read and write. */
let folder: string | null
let picked: string | null
let extra: Partial<MirrorStatus>

function status(): MirrorStatus {
  return {
    supported: true,
    folder,
    paused: null,
    diverged: [],
    failed: [],
    last_pass_ms: null,
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
  extra = {}
  stubInvoke(vi.mocked(invoke), {
    get_mirror_status: () => status(),
    pick_mirror_folder: () => picked,
    set_mirror_folder: (args) => {
      folder = args['path'] as string | null
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
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('set_mirror_folder', { path: null })
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
