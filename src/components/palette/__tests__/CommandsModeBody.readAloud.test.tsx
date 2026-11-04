/**
 * The palette's *Read aloud* commands (#5745): Read page aloud where *Read aloud* can speak, and
 * Stop reading only while it reads.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { installFakeSpeech } from '@/__tests__/helpers/fake-speech'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { CommandsModeBody } from '@/components/palette/CommandsModeBody'
import { Command, CommandList } from '@/components/ui/command'
import type { SpeechStatus } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import {
  __resetReadAloudForTests,
  getReadAloudSnapshot,
  startReading,
} from '@/lib/speech/read-aloud'
import { useCommandPaletteStore } from '@/stores/useCommandPaletteStore'

const onClose = vi.fn()

function renderBody(status: () => SpeechStatus | Promise<SpeechStatus>) {
  vi.mocked(invoke).mockImplementation(mockInvokeCommands({ speech_status: status }))
  return render(
    <Command label={t('palette.dialogTitle')}>
      <CommandList>
        <CommandsModeBody onEscalate={vi.fn()} onClose={onClose} t={t} />
      </CommandList>
    </Command>,
  )
}

const READ_COMMANDS = ['read-page-aloud']

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  __resetReadAloudForTests()
  useCommandPaletteStore.setState({ query: '' })
  installFakeSpeech()
})

afterEach(() => {
  // Before the fake goes: a test that failed mid-reading must not end it on a later unmount.
  __resetReadAloudForTests()
  vi.unstubAllGlobals()
})

describe('CommandsModeBody — Read aloud', () => {
  it('offers reading the page where Read aloud can speak', async () => {
    renderBody(() => 'Webview')
    for (const id of READ_COMMANDS) {
      expect(await screen.findByTestId(`palette-cmd-${id}`)).toBeInTheDocument()
    }
    expect(screen.queryByTestId('palette-cmd-stop-reading')).not.toBeInTheDocument()
  })

  it('offers none of them where the backend has no engine', async () => {
    const status = vi.fn((): SpeechStatus => 'Unsupported')
    renderBody(status)
    await waitFor(() => expect(status).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(screen.getByTestId('palette-cmd-go-journal')).toBeInTheDocument()
    for (const id of [...READ_COMMANDS, 'stop-reading']) {
      expect(screen.queryByTestId(`palette-cmd-${id}`)).not.toBeInTheDocument()
    }
  })

  it('offers none of them, and logs, when speech_status rejects', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    renderBody(() => Promise.reject(new Error('ipc down')))
    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    for (const id of READ_COMMANDS) {
      expect(screen.queryByTestId(`palette-cmd-${id}`)).not.toBeInTheDocument()
    }
  })

  it('offers Stop reading while it reads, which stops it', async () => {
    const user = userEvent.setup()
    renderBody(() => 'Webview')
    await screen.findByTestId('palette-cmd-read-page-aloud')
    act(() => startReading([{ blockId: 'A', text: 'a' }], {}))
    await user.click(await screen.findByTestId('palette-cmd-stop-reading'))
    expect(getReadAloudSnapshot().reading).toBe(false)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('palette-cmd-stop-reading')).not.toBeInTheDocument()
  })

  it('has no a11y violations with the commands offered', async () => {
    const { container } = renderBody(() => 'Webview')
    await screen.findByTestId('palette-cmd-read-page-aloud')
    expect(await axe(container)).toHaveNoViolations()
  })
})
