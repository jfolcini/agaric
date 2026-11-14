import { afterEach, describe, expect, it, vi } from 'vitest'

const mockReadAttachmentMeta = vi.hoisted(() => vi.fn())
const mockReadAttachment = vi.hoisted(() => vi.fn())
const mockSaveToDownloads = vi.hoisted(() => vi.fn())
const mockNotifyError = vi.hoisted(() => vi.fn())
const mockNotifyInfo = vi.hoisted(() => vi.fn())

vi.mock('@/lib/bindings', () => ({
  commands: { readAttachmentMeta: mockReadAttachmentMeta, saveToDownloads: mockSaveToDownloads },
}))
vi.mock('@/lib/ipc-helpers', () => ({ readAttachment: mockReadAttachment }))
vi.mock('@/lib/notify', () => ({ notify: { error: mockNotifyError, info: mockNotifyInfo } }))

import { formatSize, openAttachmentLink, saveBlob } from '@/lib/attachment-utils'
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

    // #6538 — the Android WebView handles no `blob:` download.
    it('on Android starts no download and says file saving is unavailable', async () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36',
      )
      __resetPlatformCacheForTests()
      try {
        const downloads = captureDownloads()
        mockReadAttachmentMeta.mockResolvedValue({
          status: 'ok',
          data: { filename: 'paper.docx', mime_type: 'application/msword' },
        })
        mockReadAttachment.mockResolvedValue(new Uint8Array([1]))

        await openAttachmentLink('01ATT')

        expect(downloads).toEqual([])
        expect(mockNotifyInfo).toHaveBeenCalledWith(t('data.fileSaveUnavailableAndroid'))
        expect(mockNotifyError).not.toHaveBeenCalled()
      } finally {
        __resetPlatformCacheForTests()
      }
    })
  })

  describe('saveBlob', () => {
    afterEach(() => {
      vi.restoreAllMocks()
      vi.useRealTimers()
      mockSaveToDownloads.mockReset()
      __resetPlatformCacheForTests()
    })

    function onMac(): void {
      vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
      __resetPlatformCacheForTests()
    }

    it('clicks a temporary anchor while attached, detaches it, and revokes the URL a tick later', async () => {
      vi.useFakeTimers()
      const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:agaric/x')
      const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
      // The anchor is detached again after the click, so `attached` is read inside it.
      const clicks: { tag: string; href: string; download: string; attached: boolean }[] = []
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        clicks.push({
          tag: this.tagName,
          href: this.getAttribute('href') ?? '',
          download: this.getAttribute('download') ?? '',
          attached: document.body.contains(this),
        })
      })
      const blob = new Blob(['zip bytes'])

      await saveBlob(blob, 'agaric-export.zip')

      expect(createObjectURL).toHaveBeenCalledWith(blob)
      expect(clicks).toEqual([
        { tag: 'A', href: 'blob:agaric/x', download: 'agaric-export.zip', attached: true },
      ])
      expect(document.body.querySelector('a')).toBeNull()
      expect(revokeObjectURL).not.toHaveBeenCalled()
      vi.runAllTimers()
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:agaric/x')
      expect(mockSaveToDownloads).not.toHaveBeenCalled()
    })

    // #6652: WKWebView cancels the anchor's download, so macOS saves through the backend.
    it('on macOS hands the bytes to the backend and clicks no anchor', async () => {
      onMac()
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
      mockSaveToDownloads.mockResolvedValue({ status: 'ok', data: null })

      await saveBlob(new Blob(['# Notes\n'], { type: 'text/markdown' }), 'Notes.md')

      expect(mockSaveToDownloads).toHaveBeenCalledWith('Notes.md', btoa('# Notes\n'))
      expect(click).not.toHaveBeenCalled()
    })

    it('on macOS rejects when the backend could not save', async () => {
      onMac()
      const failure = { kind: 'Io', message: 'disk full' }
      mockSaveToDownloads.mockResolvedValue({ status: 'error', error: failure })

      await expect(saveBlob(new Blob(['x']), 'x.md')).rejects.toBe(failure)
    })

    it('on macOS a failed attachment save is toasted', async () => {
      onMac()
      mockReadAttachmentMeta.mockResolvedValue({
        status: 'ok',
        data: { filename: 'paper.pdf', mime_type: 'application/pdf' },
      })
      mockReadAttachment.mockResolvedValue(new Uint8Array([37, 80]))
      mockSaveToDownloads.mockResolvedValue({
        status: 'error',
        error: { kind: 'Io', message: 'disk full' },
      })

      await openAttachmentLink('01ATT')

      expect(mockSaveToDownloads).toHaveBeenCalledWith('paper.pdf', btoa('%P'))
      expect(mockNotifyError).toHaveBeenCalledWith(t('attachments.loadFailed'))
      mockNotifyError.mockReset()
      mockReadAttachmentMeta.mockReset()
      mockReadAttachment.mockReset()
    })
  })
})
