import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${encodeURIComponent(path)}`),
}))

const { convertFileSrc } = await import('@tauri-apps/api/core')
const mockedConvertFileSrc = vi.mocked(convertFileSrc)

import { formatSize, getAssetUrl } from '../attachment-utils'

describe('attachment-utils', () => {
  describe('getAssetUrl', () => {
    it('returns null when not in Tauri environment', () => {
      delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__']
      expect(getAssetUrl('/path/to/file.png')).toBeNull()
    })

    it('returns asset URL when in Tauri environment', () => {
      ;(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {}
      const result = getAssetUrl('/path/to/file.png')
      expect(result).not.toBeNull()
      expect(mockedConvertFileSrc).toHaveBeenCalledWith('/path/to/file.png')
    })

    it('returns null when convertFileSrc throws', () => {
      ;(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {}
      mockedConvertFileSrc.mockImplementationOnce(() => {
        throw new Error('Not available')
      })
      expect(getAssetUrl('/bad/path')).toBeNull()
    })
  })

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
})
