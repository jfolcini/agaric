import { afterEach, describe, expect, it } from 'vitest'

import { formatErrorForDisplay } from '@/lib/error-display'
import { useDebugStore } from '@/stores/useDebugStore'

afterEach(() => {
  // Reset the app-wide flag so cross-test ordering can't leak debug state.
  useDebugStore.setState({ debugMode: false })
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
      message: 'Validation error: pairing.passphrase.mismatch',
    }

    it('shows the cleaned message without the kind when debug is off', () => {
      expect(formatErrorForDisplay(appError, { debug: false })).toBe('pairing.passphrase.mismatch')
    })

    it('appends the kind as a code when debug is on', () => {
      expect(formatErrorForDisplay(appError, { debug: true })).toBe(
        'pairing.passphrase.mismatch · code: validation',
      )
    })

    it('preserves the (err: <id>) correlation code in both modes', () => {
      const sanitized = {
        kind: 'invalid_operation',
        message: 'an internal error occurred (err: 7F3A2)',
      }
      expect(formatErrorForDisplay(sanitized, { debug: false })).toBe(
        'an internal error occurred (err: 7F3A2)',
      )
      expect(formatErrorForDisplay(sanitized, { debug: true })).toBe(
        'an internal error occurred (err: 7F3A2) · code: invalid_operation',
      )
    })
  })

  it('falls back to the live store value when no explicit debug flag is passed', () => {
    const appError = { kind: 'io', message: 'IO error: disk full' }
    // Store defaults to off.
    expect(formatErrorForDisplay(appError)).toBe('disk full')
    useDebugStore.setState({ debugMode: true })
    expect(formatErrorForDisplay(appError)).toBe('disk full · code: io')
  })
})
