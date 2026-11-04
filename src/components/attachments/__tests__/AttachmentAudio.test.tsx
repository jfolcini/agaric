import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'

const mockedReadAttachment = vi.hoisted(() => vi.fn())

vi.mock('@/lib/ipc-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc-helpers')>()),
  readAttachment: mockedReadAttachment,
}))

import { AttachmentAudio } from '@/components/attachments/AttachmentAudio'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'

const att = { id: 'att-audio', filename: 'rec.ogg', mime_type: 'audio/ogg' }
const fallback = <button type="button">fallback chip</button>

/** Reports every observed element in view at once, so the byte read starts on mount. */
class InViewObserver {
  callback: IntersectionObserverCallback
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
  }
  observe(target: Element): void {
    this.callback(
      [{ target, isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

describe('AttachmentAudio', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock/1')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.stubGlobal('IntersectionObserver', InViewObserver)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('plays the bytes it reads', async () => {
    mockedReadAttachment.mockResolvedValue(new Uint8Array([1, 2, 3]))
    render(<AttachmentAudio att={att} fallback={fallback} />)

    expect(
      await screen.findByLabelText(t('attachment.audioLabel', { filename: 'rec.ogg' })),
    ).toHaveAttribute('src', 'blob:mock/1')
    expect(mockedReadAttachment).toHaveBeenCalledWith('att-audio')
  })

  it('shows the fallback, and warns, when the bytes cannot be read', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const failure = new Error('boom')
    mockedReadAttachment.mockRejectedValue(failure)
    const { container } = render(<AttachmentAudio att={att} fallback={fallback} />)

    expect(await screen.findByRole('button', { name: 'fallback chip' })).toBeInTheDocument()
    expect(container.querySelector('audio')).toBeNull()
    expect(warn).toHaveBeenCalledWith(
      'AttachmentAudio',
      'read audio bytes failed',
      { id: 'att-audio' },
      failure,
    )
  })

  it('has no a11y violations with a loaded player', async () => {
    mockedReadAttachment.mockResolvedValue(new Uint8Array([1, 2, 3]))
    const { container } = render(<AttachmentAudio att={att} fallback={fallback} />)
    await waitFor(() => expect(container.querySelector('audio')).not.toBeNull())
    expect(await axe(container)).toHaveNoViolations()
  })
})
