/**
 * VoiceNoteDialog (#5364): the `/voice` recorder.
 *
 * `getUserMedia`, `MediaRecorder` and the Web Audio + WebCodecs route (#5730)
 * are faked — none exists under happy-dom — while the save goes through the
 * in-memory backend, so the attachment is asserted by re-querying
 * `list_attachments` / `read_attachment`.
 */

import { type InvokeArgs, invoke } from '@tauri-apps/api/core'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import {
  FakeAudioContext,
  FakeAudioEncoder,
  FakeAudioWorkletNode,
  OPUS_HEAD,
  fakeMicrophone,
  installWebAudioFakes,
  lastOf,
} from '@/__tests__/mocks/web-audio'
import { OggOpusWriter } from '@/components/attachments/ogg-opus'
import { VoiceNoteDialog } from '@/components/attachments/VoiceNoteDialog'
import { MAX_ATTACHMENT_BYTES } from '@/lib/file-utils'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'

const BLOCK_ID = SEED_IDS.BLOCK_GS_1

const mockedInvoke = vi.mocked(invoke)

/** Records calls and hands its chunks over only when a test says so. */
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  static isTypeSupported(type: string): boolean {
    return type === 'audio/webm;codecs=opus'
  }

  state: RecordingState = 'inactive'
  readonly options: MediaRecorderOptions | undefined
  readonly mimeType: string
  timeslice: number | undefined
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.options = options
    this.mimeType = options?.mimeType ?? ''
    FakeMediaRecorder.instances.push(this)
  }

  start(timeslice?: number): void {
    this.state = 'recording'
    this.timeslice = timeslice
  }

  /** Like the real one: `stop` is delivered asynchronously. */
  stop(): void {
    if (this.state === 'inactive') return
    this.state = 'inactive'
    queueMicrotask(() => this.onstop?.())
  }

  emit(data: Blob): void {
    this.ondataavailable?.({ data })
  }
}

/** A chunk that reports `size` bytes without allocating them. */
function chunkOfSize(size: number): Blob {
  const chunk = new Blob([new Uint8Array([7])])
  Object.defineProperty(chunk, 'size', { value: size })
  return chunk
}

function recorder(): FakeMediaRecorder {
  const instance = FakeMediaRecorder.instances.at(-1)
  if (!instance) throw new Error('no MediaRecorder was constructed')
  return instance
}

function listedAttachments(): Array<Record<string, unknown>> {
  return dispatch('list_attachments', { blockId: BLOCK_ID }) as Array<Record<string, unknown>>
}

const track = { stop: vi.fn() }
const stream = { getTracks: () => [track] } as unknown as MediaStream
const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => stream)
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')

/** The dialog the way BlockTree drives it: `onClose` clears the block id. */
function Harness({ onClose }: { onClose?: () => void }) {
  const [blockId, setBlockId] = useState<string | null>(BLOCK_ID)
  if (blockId === null) return null
  return (
    <VoiceNoteDialog
      blockId={blockId}
      onClose={() => {
        onClose?.()
        setBlockId(null)
      }}
    />
  )
}

async function startRecording(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: t('voiceNote.record') }))
  await screen.findByRole('button', { name: t('voiceNote.stop') })
}

beforeEach(() => {
  vi.clearAllMocks()
  FakeMediaRecorder.instances = []
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  })
  seedBlocks()
  mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices)
  else Reflect.deleteProperty(navigator, 'mediaDevices')
})

describe('VoiceNoteDialog', () => {
  it('opens on the Record button with the timer at zero', async () => {
    render(<Harness />)
    const record = await screen.findByRole('button', { name: t('voiceNote.record') })
    await waitFor(() => expect(record).toHaveFocus())
    expect(screen.getByRole('timer', { name: t('voiceNote.elapsed') })).toHaveTextContent('0:00')
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('records, stops, and attaches the audio to the block', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 9, 14, 5))
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<Harness onClose={onClose} />)

    await startRecording(user)
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(recorder().options).toEqual({
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 32_000,
    })
    expect(recorder().timeslice).toBe(1000)
    expect(screen.getByText(t('voiceNote.recording'))).toBeInTheDocument()

    act(() => {
      recorder().emit(new Blob([new Uint8Array([1, 2, 3])]))
      recorder().emit(new Blob([new Uint8Array([4, 5])]))
    })
    await user.click(screen.getByRole('button', { name: t('voiceNote.stop') }))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    const [row] = listedAttachments()
    expect(listedAttachments()).toHaveLength(1)
    expect(row).toMatchObject({
      filename: 'voice-note-2026-10-09-1405.webm',
      mime_type: 'audio/webm',
      size_bytes: 5,
    })
    const bytes = dispatch('read_attachment', { attachmentId: row?.['id'] }) as ArrayBuffer
    expect([...new Uint8Array(bytes)]).toEqual([1, 2, 3, 4, 5])
    expect(track.stop).toHaveBeenCalledOnce()
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(t('voiceNote.saved'))
    expect(screen.queryByTestId('voice-note-dialog')).not.toBeInTheDocument()
  })

  it('stops and saves on its own just before the attachment cap', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await startRecording(user)

    const headroom = 1_048_576
    act(() => recorder().emit(chunkOfSize(MAX_ATTACHMENT_BYTES - headroom - 1)))
    expect(recorder().state).toBe('recording')

    act(() => recorder().emit(chunkOfSize(1)))
    expect(recorder().state).toBe('inactive')
    expect(vi.mocked(toast.info)).toHaveBeenCalledWith(t('voiceNote.sizeLimitReached'))

    await waitFor(() => expect(listedAttachments()).toHaveLength(1))
    expect(track.stop).toHaveBeenCalledOnce()
  })

  it('saves what was recorded when the recorder stops on its own', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<Harness onClose={onClose} />)
    await startRecording(user)
    act(() => recorder().emit(new Blob([new Uint8Array([6, 6])])))

    // The microphone went away (unplugged, or taken by a phone call).
    act(() => {
      recorder().state = 'inactive'
      recorder().onstop?.()
    })

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(listedAttachments()).toHaveLength(1)
    expect(track.stop).toHaveBeenCalledOnce()
  })

  it('reports a denied microphone and stays ready to retry', async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException('Permission denied', 'NotAllowedError'))
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: t('voiceNote.record') }))

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('voiceNote.micDenied')),
    )
    expect(screen.getByRole('button', { name: t('voiceNote.record') })).toBeEnabled()
    expect(FakeMediaRecorder.instances).toHaveLength(0)
  })

  it('reports a missing microphone', async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException('No device', 'NotFoundError'))
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: t('voiceNote.record') }))

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('voiceNote.micNotFound')),
    )
  })

  it('reports a webview with no microphone API instead of throwing', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined })
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: t('voiceNote.record') }))

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('voiceNote.micUnavailable'))
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('a click outside closes the idle dialog but not a recording one', async () => {
    // Radix arms its outside listener a tick after mount, and a dialog only
    // acts on an outside pointerdown once the click that follows it lands.
    const clickOutside = async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      fireEvent.pointerDown(document.body)
      fireEvent.click(document.body)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
    const user = userEvent.setup()
    const { unmount } = render(<Harness />)
    await screen.findByTestId('voice-note-dialog')
    await clickOutside()
    expect(screen.queryByTestId('voice-note-dialog')).not.toBeInTheDocument()
    unmount()

    render(<Harness />)
    await startRecording(user)
    await clickOutside()

    expect(screen.getByTestId('voice-note-dialog')).toBeInTheDocument()
    expect(recorder().state).toBe('recording')
  })

  it('Escape closes the idle dialog but not a recording one', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<Harness />)
    await screen.findByTestId('voice-note-dialog')
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('voice-note-dialog')).not.toBeInTheDocument()
    unmount()

    render(<Harness />)
    await startRecording(user)
    await user.keyboard('{Escape}')

    expect(screen.getByTestId('voice-note-dialog')).toBeInTheDocument()
    expect(recorder().state).toBe('recording')
    expect(track.stop).not.toHaveBeenCalled()
  })

  it('Cancel while recording releases the microphone and saves nothing', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await startRecording(user)
    act(() => recorder().emit(new Blob([new Uint8Array([1])])))

    await user.click(screen.getByRole('button', { name: t('action.cancel') }))
    await act(async () => {})

    expect(screen.queryByTestId('voice-note-dialog')).not.toBeInTheDocument()
    expect(track.stop).toHaveBeenCalled()
    expect(recorder().state).toBe('inactive')
    expect(listedAttachments()).toEqual([])
  })

  it('unmounting while recording releases the microphone and saves nothing', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<Harness />)
    await startRecording(user)

    unmount()
    await act(async () => {})

    expect(track.stop).toHaveBeenCalled()
    expect(recorder().state).toBe('inactive')
    expect(listedAttachments()).toEqual([])
  })

  it('releases a microphone granted after the dialog was closed', async () => {
    let grant: (value: MediaStream) => void = () => {}
    getUserMedia.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          grant = resolve
        }),
    )
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: t('voiceNote.record') }))
    await user.click(screen.getByRole('button', { name: t('action.cancel') }))

    await act(async () => grant(stream))

    expect(track.stop).toHaveBeenCalledOnce()
    expect(FakeMediaRecorder.instances).toHaveLength(0)
  })

  it('hands focus back to the button once recording starts', async () => {
    let grant: (value: MediaStream) => void = () => {}
    getUserMedia.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          grant = resolve
        }),
    )
    const user = userEvent.setup()
    render(<Harness />)
    const button = screen.getByRole('button', { name: t('voiceNote.record') })
    await user.click(button)
    // A browser drops focus from a button that becomes disabled; happy-dom
    // keeps it there (and refuses to blur a disabled element), so drop it here.
    act(() => {
      ;(button as HTMLButtonElement).disabled = false
      button.blur()
      ;(button as HTMLButtonElement).disabled = true
    })
    expect(button).not.toHaveFocus()

    await act(async () => grant(stream))

    expect(screen.getByRole('button', { name: t('voiceNote.stop') })).toHaveFocus()
  })

  it('keeps a recording whose save failed, and saves it on retry', async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'add_attachment_with_bytes') throw new Error('disk full')
      return dispatch(cmd, args)
    })
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<Harness onClose={onClose} />)
    await startRecording(user)
    act(() => recorder().emit(new Blob([new Uint8Array([9, 8])])))
    await user.click(screen.getByRole('button', { name: t('voiceNote.stop') }))

    const retry = await screen.findByRole('button', { name: t('voiceNote.retry') })
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('voiceNote.saveFailed'))
    expect(listedAttachments()).toEqual([])
    expect(onClose).not.toHaveBeenCalled()

    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
    await user.click(retry)

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    const [row] = listedAttachments()
    const bytes = dispatch('read_attachment', { attachmentId: row?.['id'] }) as ArrayBuffer
    expect([...new Uint8Array(bytes)]).toEqual([9, 8])
  })

  it('has no a11y violations while idle', async () => {
    render(<Harness />)
    const dialog = await screen.findByTestId('voice-note-dialog')
    await waitFor(async () => {
      expect(await axe(dialog)).toHaveNoViolations()
    })
  })

  it('has no a11y violations while recording', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await startRecording(user)
    const dialog = screen.getByTestId('voice-note-dialog')
    await waitFor(async () => {
      expect(await axe(dialog)).toHaveNoViolations()
    })
  })
})

describe('VoiceNoteDialog on WebKitGTK, encoding Ogg Opus itself (#5730)', () => {
  const CELT_20MS = 19 << 3
  let mic: ReturnType<typeof fakeMicrophone>

  beforeEach(() => {
    installWebAudioFakes()
    vi.stubGlobal('MediaRecorder', undefined)
    mic = fakeMicrophone()
    getUserMedia.mockImplementation(async () => mic.stream)
  })

  afterEach(() => {
    getUserMedia.mockImplementation(async () => stream)
    vi.restoreAllMocks()
  })

  function audioPacket(fill: number): Uint8Array {
    const bytes = new Uint8Array(40).fill(fill)
    bytes[0] = CELT_20MS
    return bytes
  }

  function encoder(): FakeAudioEncoder {
    return lastOf(FakeAudioEncoder.instances)
  }

  function context(): FakeAudioContext {
    return lastOf(FakeAudioContext.instances)
  }

  it('records, stops, and attaches an Ogg Opus file to the block', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 18, 9, 30))
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<Harness onClose={onClose} />)

    await startRecording(user)
    act(() => {
      lastOf(FakeAudioWorkletNode.instances).feed(new Float32Array(2048))
      encoder().emit(audioPacket(1))
      encoder().emit(audioPacket(2))
    })
    await user.click(screen.getByRole('button', { name: t('voiceNote.stop') }))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    const [row] = listedAttachments()
    expect(listedAttachments()).toHaveLength(1)
    expect(row).toMatchObject({
      filename: 'voice-note-2026-10-18-0930.ogg',
      mime_type: 'audio/ogg',
    })
    const expected = new OggOpusWriter(OPUS_HEAD)
    expected.addPacket(audioPacket(1))
    expected.addPacket(audioPacket(2))
    const bytes = dispatch('read_attachment', { attachmentId: row?.['id'] }) as ArrayBuffer
    expect([...new Uint8Array(bytes)]).toEqual([
      ...new Uint8Array(await expected.finish().arrayBuffer()),
    ])
    expect(mic.track.stop).toHaveBeenCalledOnce()
    expect(context().close).toHaveBeenCalledOnce()
  })

  it('Cancel while recording releases the microphone and the audio context, and saves nothing', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await startRecording(user)
    act(() => encoder().emit(audioPacket(1)))

    await user.click(screen.getByRole('button', { name: t('action.cancel') }))
    await act(async () => {})

    expect(screen.queryByTestId('voice-note-dialog')).not.toBeInTheDocument()
    expect(mic.track.stop).toHaveBeenCalledOnce()
    expect(context().close).toHaveBeenCalledOnce()
    expect(listedAttachments()).toEqual([])
  })

  it('unmounting while recording releases the microphone and the audio context', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<Harness />)
    await startRecording(user)

    unmount()
    await act(async () => {})

    expect(mic.track.stop).toHaveBeenCalledOnce()
    expect(context().close).toHaveBeenCalledOnce()
    expect(listedAttachments()).toEqual([])
  })

  it('saves what was encoded when the encoder fails mid-recording', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<Harness onClose={onClose} />)
    await startRecording(user)

    act(() => {
      encoder().emit(audioPacket(3))
      encoder().fail(new DOMException('encoder crashed', 'EncodingError'))
    })

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(listedAttachments()).toHaveLength(1)
    expect(mic.track.stop).toHaveBeenCalledOnce()
    expect(context().close).toHaveBeenCalledOnce()
  })

  it('reports an encoder that fails before any audio, and is ready to record again', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const user = userEvent.setup()
    render(<Harness />)
    await startRecording(user)

    const failure = new DOMException('encoder crashed', 'EncodingError')
    act(() => encoder().fail(failure))

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('voiceNote.micError')),
    )
    expect(error).toHaveBeenCalledWith(
      'VoiceNoteDialog',
      'the recording failed',
      undefined,
      failure,
    )
    expect(screen.getByRole('button', { name: t('voiceNote.record') })).toBeEnabled()
    expect(mic.track.stop).toHaveBeenCalledOnce()
    expect(context().close).toHaveBeenCalledOnce()
    expect(listedAttachments()).toEqual([])
  })

  it('reports an encoder that cannot take the microphone, and releases it', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    FakeAudioEncoder.supported = false
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: t('voiceNote.record') }))

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('voiceNote.micError')),
    )
    expect(screen.getByRole('button', { name: t('voiceNote.record') })).toBeEnabled()
    expect(mic.track.stop).toHaveBeenCalledOnce()
    expect(context().close).toHaveBeenCalledOnce()
  })

  it('stops a recorder that finished starting after the dialog was closed', async () => {
    let answer: () => void = () => {}
    FakeAudioEncoder.isConfigSupported.mockImplementationOnce(
      (config) =>
        new Promise((resolve) => {
          answer = () => resolve({ supported: true, config })
        }),
    )
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: t('voiceNote.record') }))
    await waitFor(() => expect(FakeAudioEncoder.isConfigSupported).toHaveBeenCalled())
    await user.click(screen.getByRole('button', { name: t('action.cancel') }))

    await act(async () => answer())

    expect(mic.track.stop).toHaveBeenCalledOnce()
    expect(context().close).toHaveBeenCalledOnce()
    expect(listedAttachments()).toEqual([])
  })
})
