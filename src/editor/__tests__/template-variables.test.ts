import { describe, expect, it } from 'vitest'

import { substituteTemplateVariables } from '../template-variables'

// A fixed clock so date/time assertions are deterministic.
// 2026-03-07 09:05 local time.
const NOW = new Date(2026, 2, 7, 9, 5, 0)

describe('substituteTemplateVariables', () => {
  it('expands {{date}} to the ISO YYYY-MM-DD date', () => {
    const { text } = substituteTemplateVariables('Due: {{date}}', { now: NOW })
    expect(text).toBe('Due: 2026-03-07')
  })

  it('expands {{time}} to HH:mm', () => {
    const { text } = substituteTemplateVariables('At {{time}}', { now: NOW })
    expect(text).toBe('At 09:05')
  })

  it('expands {{title}} from the page-title context', () => {
    const { text } = substituteTemplateVariables('Page: {{title}}', {
      pageTitle: 'My Notes',
      now: NOW,
    })
    expect(text).toBe('Page: My Notes')
  })

  it('expands {{title}} to empty string when no title in context', () => {
    const { text } = substituteTemplateVariables('Page: {{title}}', { now: NOW })
    expect(text).toBe('Page: ')
  })

  describe('{{date:FORMAT}}', () => {
    it('maps YYYY/MM/DD onto date-fns tokens', () => {
      const { text } = substituteTemplateVariables('{{date:YYYY/MM/DD}}', { now: NOW })
      expect(text).toBe('2026/03/07')
    })

    it('supports {{date:YYYY}} for the year alone', () => {
      const { text } = substituteTemplateVariables('{{date:YYYY}}', { now: NOW })
      expect(text).toBe('2026')
    })

    it('passes a raw date-fns pattern through (MMM d, yyyy)', () => {
      const { text } = substituteTemplateVariables('{{date:MMM d, yyyy}}', { now: NOW })
      expect(text).toBe('Mar 7, 2026')
    })

    it('tolerates whitespace around the format', () => {
      const { text } = substituteTemplateVariables('{{ date : YYYY-MM-DD }}', { now: NOW })
      expect(text).toBe('2026-03-07')
    })
  })

  it('leaves unknown tokens verbatim (does not drop them)', () => {
    const { text } = substituteTemplateVariables('{{foo}} and {{bar:baz}}', { now: NOW })
    expect(text).toBe('{{foo}} and {{bar:baz}}')
  })

  it('expands a token wrapped in markdown marks (bold/italic) and keeps the marks', () => {
    // Block content is canonical markdown, so a token inside marks is a
    // contiguous substring (`**{{date}}**`) — the marks survive untouched.
    const { text } = substituteTemplateVariables('**{{date}}** and _{{title}}_', {
      pageTitle: 'Standup',
      now: NOW,
    })
    expect(text).toBe('**2026-03-07** and _Standup_')
  })

  it('expands multiple tokens in one string', () => {
    const { text } = substituteTemplateVariables('{{date}} — {{title}}', {
      pageTitle: 'Standup',
      now: NOW,
    })
    expect(text).toBe('2026-03-07 — Standup')
  })

  it('is case-insensitive for token names', () => {
    const { text } = substituteTemplateVariables('{{DATE}} {{Time}}', { now: NOW })
    expect(text).toBe('2026-03-07 09:05')
  })

  describe('{{cursor}} marker', () => {
    it('strips the marker and reports hasCursor', () => {
      const { text, hasCursor } = substituteTemplateVariables('start {{cursor}}end', { now: NOW })
      expect(text).toBe('start end')
      expect(hasCursor).toBe(true)
    })

    it('reports hasCursor=false when no marker present', () => {
      const { hasCursor } = substituteTemplateVariables('no marker here', { now: NOW })
      expect(hasCursor).toBe(false)
    })

    it('strips all markers but still reports a single hasCursor', () => {
      const { text, hasCursor } = substituteTemplateVariables('a{{cursor}}b{{cursor}}c', {
        now: NOW,
      })
      expect(text).toBe('abc')
      expect(hasCursor).toBe(true)
    })
  })

  describe('escaping', () => {
    it('treats \\{{ as a literal {{ and does not expand the token', () => {
      const { text } = substituteTemplateVariables('\\{{date}}', { now: NOW })
      expect(text).toBe('{{date}}')
    })

    it('mixes an escaped literal and a real token', () => {
      const { text } = substituteTemplateVariables('\\{{date}} vs {{date}}', { now: NOW })
      expect(text).toBe('{{date}} vs 2026-03-07')
    })
  })

  it('returns content unchanged when no tokens are present', () => {
    const { text, hasCursor } = substituteTemplateVariables('plain text', { now: NOW })
    expect(text).toBe('plain text')
    expect(hasCursor).toBe(false)
  })

  it('uses the live clock by default when no now is supplied', () => {
    const { text } = substituteTemplateVariables('{{date}}', {})
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
