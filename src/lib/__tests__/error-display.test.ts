import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { formatErrorForDisplay, VALIDATION_CODE_KEYS } from '@/lib/error-display'
import { i18n } from '@/lib/i18n'
import { loadLocale } from '@/lib/i18n/set-locale'
import { PREFERENCES, removePreference, writePreference } from '@/lib/preferences'

afterEach(() => {
  // Reset the app-wide flag so cross-test ordering can't leak debug state.
  removePreference(PREFERENCES.debugMode)
})

describe('formatErrorForDisplay', () => {
  it('passes plain strings through verbatim regardless of debug mode', () => {
    expect(formatErrorForDisplay('Could not save', { debug: false })).toBe('Could not save')
    expect(formatErrorForDisplay('Could not save', { debug: true })).toBe('Could not save')
  })

  it('coerces numbers to a string', () => {
    expect(formatErrorForDisplay(42, { debug: true })).toBe('42')
  })

  it('strips the Rust Display prefix from an Error message', () => {
    const err = new Error('Validation error: title must not be empty')
    expect(formatErrorForDisplay(err, { debug: false })).toBe('title must not be empty')
  })

  it('does not append a code for a plain Error (no kind) even in debug mode', () => {
    const err = new Error('Sync timed out')
    expect(formatErrorForDisplay(err, { debug: true })).toBe('Sync timed out')
  })

  describe('unrecognised throws (fallback)', () => {
    it('uses the caller fallback instead of String(err) for non-Error values', () => {
      expect(formatErrorForDisplay(undefined, { fallback: 'Failed to rename' })).toBe(
        'Failed to rename',
      )
      expect(formatErrorForDisplay({ not: 'an error' }, { fallback: 'Sync failed' })).toBe(
        'Sync failed',
      )
    })

    it('falls back to String(err) when no fallback is supplied', () => {
      expect(formatErrorForDisplay(undefined)).toBe('undefined')
    })

    it('ignores the fallback for real Error / AppError values', () => {
      expect(formatErrorForDisplay(new Error('boom'), { fallback: 'ignored' })).toBe('boom')
      expect(
        formatErrorForDisplay(
          { kind: 'io', message: 'IO error: disk full' },
          { fallback: 'ignored', debug: false },
        ),
      ).toBe('disk full')
    })
  })

  describe('IPC AppError objects', () => {
    const appError = {
      kind: 'validation',
      message: 'Validation error: pairing.no_active_session',
    }

    it('shows the cleaned message without the kind when debug is off', () => {
      expect(formatErrorForDisplay(appError, { debug: false })).toBe('pairing.no_active_session')
    })

    it('appends the kind as a code when debug is on', () => {
      expect(formatErrorForDisplay(appError, { debug: true })).toBe(
        'pairing.no_active_session · code: validation',
      )
    })

    it('appends kind/code for a coded validation error when debug is on (#2251)', () => {
      const coded = { kind: 'validation', message: 'unclosed group', code: 'InvalidRegex' }
      expect(formatErrorForDisplay(coded, { debug: false })).toBe(
        'That regular expression is not valid.',
      )
      expect(formatErrorForDisplay(coded, { debug: true })).toBe(
        'That regular expression is not valid. · unclosed group · code: validation/InvalidRegex',
      )
    })

    it('preserves the (err: <id>) correlation code in both modes', () => {
      // #2045: sanitized internal failures arrive with wire `kind:"internal"`
      // and the Rust `Internal error: ` Display prefix.
      const sanitized = {
        kind: 'internal',
        message: 'Internal error: an internal error occurred (err: 7F3A2)',
      }
      expect(formatErrorForDisplay(sanitized, { debug: false })).toBe(
        'Something went wrong (err: 7F3A2)',
      )
      expect(formatErrorForDisplay(sanitized, { debug: true })).toBe(
        'Something went wrong (err: 7F3A2) · an internal error occurred (err: 7F3A2) · code: internal',
      )
    })
  })

  it('falls back to the stored preference when no explicit debug flag is passed', () => {
    const appError = { kind: 'io', message: 'IO error: disk full' }
    // Defaults to off.
    expect(formatErrorForDisplay(appError)).toBe('disk full')
    writePreference(PREFERENCES.debugMode, true)
    expect(formatErrorForDisplay(appError)).toBe('disk full · code: io')
  })
})

describe('backend errors in the UI language', () => {
  beforeAll(async () => {
    await loadLocale('es')
    await i18n.changeLanguage('es')
  })

  afterAll(async () => {
    await i18n.changeLanguage('en')
  })

  const badRegex = { kind: 'validation', code: 'InvalidRegex', message: 'unclosed group' }
  const sanitized = {
    kind: 'internal',
    message: 'Internal error: an internal error occurred (err: 7F3A2)',
  }

  it('renders a coded validation error as the sentence for its code', () => {
    expect(formatErrorForDisplay(badRegex, { debug: false })).toBe(
      'Esa expresión regular no es válida.',
    )
  })

  it('renders a sanitized internal error as a sentence that keeps its correlation id', () => {
    expect(formatErrorForDisplay(sanitized, { debug: false })).toBe(
      'Algo ha salido mal (err: 7F3A2)',
    )
  })

  it('shows the raw message and the code after the sentence in debug mode', () => {
    expect(formatErrorForDisplay(badRegex, { debug: true })).toBe(
      'Esa expresión regular no es válida. · unclosed group · code: validation/InvalidRegex',
    )
    expect(formatErrorForDisplay(sanitized, { debug: true })).toBe(
      'Algo ha salido mal (err: 7F3A2) · an internal error occurred (err: 7F3A2) · code: internal',
    )
  })

  it("keeps a taken title's backend message, which names the title", () => {
    const taken = {
      kind: 'validation',
      code: 'DuplicatePageTitle',
      message: "a page titled 'Home' already exists in this space",
    }
    expect(formatErrorForDisplay(taken, { debug: false })).toBe(taken.message)
  })

  it('keeps the message of an uncoded error, or of an internal one without an id', () => {
    expect(
      formatErrorForDisplay(
        { kind: 'validation', message: 'Validation error: move fewer pages' },
        { debug: false },
      ),
    ).toBe('move fewer pages')
    expect(
      formatErrorForDisplay(
        { kind: 'internal', message: 'Internal error: worker panicked' },
        { debug: false },
      ),
    ).toBe('worker panicked')
    expect(
      formatErrorForDisplay(
        { kind: 'database', message: 'Database error: locked (err: 7F3A2)' },
        { debug: false },
      ),
    ).toBe('locked (err: 7F3A2)')
  })
})

it('maps every validation code to a key the English catalog holds, or to null', () => {
  const missing = Object.entries(VALIDATION_CODE_KEYS).filter(
    ([, key]) => key !== null && i18n.getResource('en', 'translation', key) === undefined,
  )
  expect(missing).toEqual([])
})
