import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockReadAttachmentMeta = vi.hoisted(() => vi.fn())
const mockReadAttachment = vi.hoisted(() => vi.fn())
const mockNotifyError = vi.hoisted(() => vi.fn())
const mockSaveToAndroidDownloads = vi.hoisted(() => vi.fn())

vi.mock('@/lib/bindings', () => ({
  commands: { readAttachmentMeta: mockReadAttachmentMeta },
}))
vi.mock('@/lib/ipc-helpers', () => ({ readAttachment: mockReadAttachment }))
vi.mock('@/lib/notify', () => ({ notify: { error: mockNotifyError } }))
vi.mock('@/lib/platform/android-save', () => ({
  saveToAndroidDownloads: mockSaveToAndroidDownloads,
}))

import { formatSize, openAttachmentLink } from '@/lib/attachment-utils'
import { t } from '@/lib/i18n'
import { __resetPlatformCacheForTests } from '@/lib/platform'

describe('attachment-utils', () => {
  describe('formatSize', () => {
    it('formats bytes', () => {
      expect(formatSize(512)).toBe('512 B')
    })

    it('formats kilobytes', () => {
      expect(formatSize(2048)).toBe('2.0 KB')
    })

    it('formats megabytes', () => {
      expect(formatSize(1048576)).toBe('1.0 MB')
    })

    it('formats zero bytes', () => {
      expect(formatSize(0)).toBe('0 B')
    })

    it('formats fractional kilobytes', () => {
      expect(formatSize(1536)).toBe('1.5 KB')
    })
  })

  describe('openAttachmentLink (#6032)', () => {
    afterEach(() => {
      vi.restoreAllMocks()
      mockReadAttachmentMeta.mockReset()
      mockReadAttachment.mockReset()
      mockNotifyError.mockReset()
    })

    /** The `download` name and blob type of each download the page starts. */
    function captureDownloads(): Array<{ name: string; type: string }> {
      const blobs = new Map<string, Blob>()
      vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
        const url = `blob:${blobs.size}`
        blobs.set(url, blob as Blob)
        return url
      })
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
      const downloads: Array<{ name: string; type: string }> = []
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        downloads.push({ name: this.download, type: blobs.get(this.href)?.type ?? '' })
      })
      return downloads
    }

    it('downloads the attachment under its stored name and type', async () => {
      const downloads = captureDownloads()
      mockReadAttachmentMeta.mockResolvedValue({
        status: 'ok',
        data: { filename: 'paper.pdf', mime_type: 'application/pdf' },
      })
      mockReadAttachment.mockResolvedValue(new Uint8Array([37, 80, 68, 70]))

      await openAttachmentLink('01ATT')

      expect(mockReadAttachmentMeta).toHaveBeenCalledWith('01ATT')
      expect(downloads).toEqual([{ name: 'paper.pdf', type: 'application/pdf' }])
      expect(mockNotifyError).not.toHaveBeenCalled()
    })

    it('toasts and starts no download when the attachment cannot be read', async () => {
      const downloads = captureDownloads()
      mockReadAttachmentMeta.mockResolvedValue({
        status: 'error',
        error: { kind: 'NotFound', message: 'attachment 01GONE' },
      })

      await openAttachmentLink('01GONE')

      expect(downloads).toEqual([])
      expect(mockNotifyError).toHaveBeenCalledWith(t('attachments.loadFailed'))
    })

    // #6546 — the Android WebView handles no `blob:` download.
    describe('on Android', () => {
      beforeEach(() => {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
          'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36',
        )
        __resetPlatformCacheForTests()
        mockReadAttachmentMeta.mockResolvedValue({
          status: 'ok',
          data: { filename: 'paper.docx', mime_type: 'application/msword' },
        })
        mockReadAttachment.mockResolvedValue(new Uint8Array([1]))
      })

      afterEach(() => {
        mockSaveToAndroidDownloads.mockReset()
        __resetPlatformCacheForTests()
      })

      it('saves the attachment to Downloads under its stored name and type, with no anchor', async () => {
        const downloads = captureDownloads()
        mockSaveToAndroidDownloads.mockResolvedValue(undefined)

        await openAttachmentLink('01ATT')

        expect(mockSaveToAndroidDownloads).toHaveBeenCalledTimes(1)
        const [blob, name] = mockSaveToAndroidDownloads.mock.calls[0] as [Blob, string]
        expect(name).toBe('paper.docx')
        expect(blob.type).toBe('application/msword')
        expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1]))
        expect(downloads).toEqual([])
        expect(mockNotifyError).not.toHaveBeenCalled()
      })

      it('toasts an error when the save fails', async () => {
        mockSaveToAndroidDownloads.mockRejectedValue({ kind: 'io', message: 'no space left' })

        await openAttachmentLink('01ATT')

        expect(mockNotifyError).toHaveBeenCalledWith(t('attachments.loadFailed'))
      })
    })
  })
})
