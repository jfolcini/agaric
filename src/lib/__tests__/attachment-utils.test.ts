import { describe, expect, it } from 'vitest'

import { formatSize } from '../attachment-utils'

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
})
