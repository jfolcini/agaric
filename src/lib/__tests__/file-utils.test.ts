import { describe, expect, it } from 'vitest'
import { extractFileInfo, guessMimeType } from '../file-utils'

describe('guessMimeType', () => {
  it('returns correct MIME type for common image extensions', () => {
    expect(guessMimeType('photo.jpg')).toBe('image/jpeg')
    expect(guessMimeType('photo.jpeg')).toBe('image/jpeg')
    expect(guessMimeType('photo.png')).toBe('image/png')
    expect(guessMimeType('photo.gif')).toBe('image/gif')
    expect(guessMimeType('icon.svg')).toBe('image/svg+xml')
    expect(guessMimeType('image.webp')).toBe('image/webp')
  })

  it('returns correct MIME type for document extensions', () => {
    expect(guessMimeType('doc.pdf')).toBe('application/pdf')
    expect(guessMimeType('notes.txt')).toBe('text/plain')
    expect(guessMimeType('README.md')).toBe('text/markdown')
    expect(guessMimeType('data.json')).toBe('application/json')
    expect(guessMimeType('page.html')).toBe('text/html')
    expect(guessMimeType('style.css')).toBe('text/css')
    expect(guessMimeType('app.js')).toBe('application/javascript')
  })

  it('returns correct MIME type for office extensions', () => {
    expect(guessMimeType('report.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    expect(guessMimeType('data.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
  })

  it('returns correct MIME type for media extensions', () => {
    expect(guessMimeType('video.mp4')).toBe('video/mp4')
    expect(guessMimeType('clip.mov')).toBe('video/quicktime')
    expect(guessMimeType('song.mp3')).toBe('audio/mpeg')
    expect(guessMimeType('audio.wav')).toBe('audio/wav')
  })

  it('returns correct MIME type for archive extensions', () => {
    expect(guessMimeType('archive.zip')).toBe('application/zip')
    expect(guessMimeType('backup.tar')).toBe('application/x-tar')
  })

  it('returns application/octet-stream for unknown extensions', () => {
    expect(guessMimeType('file.xyz')).toBe('application/octet-stream')
    expect(guessMimeType('file.rar')).toBe('application/octet-stream')
  })

  it('handles files with no extension', () => {
    expect(guessMimeType('Makefile')).toBe('application/octet-stream')
  })

  it('is case-insensitive', () => {
    expect(guessMimeType('PHOTO.JPG')).toBe('image/jpeg')
    expect(guessMimeType('Doc.PDF')).toBe('application/pdf')
  })
})

describe('extractFileInfo', () => {
  it('extracts info from file with Tauri path', () => {
    const file = new File(['content'], 'test.png', { type: 'image/png' })
    Object.defineProperty(file, 'path', { value: '/tmp/test.png' })
    const info = extractFileInfo(file)
    expect(info.filename).toBe('test.png')
    expect(info.mimeType).toBe('image/png')
    expect(info.sizeBytes).toBe(7)
    expect(info.fsPath).toBe('/tmp/test.png')
  })

  it('returns null fsPath when path is not available', () => {
    const file = new File(['data'], 'doc.pdf', { type: 'application/pdf' })
    const info = extractFileInfo(file)
    expect(info.fsPath).toBeNull()
  })

  it('generates fallback filename for unnamed files', () => {
    const file = new File(['pixels'], '', { type: 'image/png' })
    const info = extractFileInfo(file)
    expect(info.filename).toMatch(/^pasted-\d+$/)
  })

  it('uses guessMimeType when file.type is empty', () => {
    const file = new File(['data'], 'photo.jpg', { type: '' })
    Object.defineProperty(file, 'path', { value: '/tmp/photo.jpg' })
    const info = extractFileInfo(file)
    expect(info.mimeType).toBe('image/jpeg')
  })

  it('prefers file.type over guessMimeType', () => {
    const file = new File(['data'], 'doc.txt', { type: 'text/html' })
    const info = extractFileInfo(file)
    expect(info.mimeType).toBe('text/html')
  })
})
