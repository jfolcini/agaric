import { describe, expect, it } from 'vitest'

import type { AppError, AppErrorKind } from '@/lib/app-error'
import { categorizeHistoryError, type HistoryErrorCategory } from '@/lib/categorize-history-error'

interface AppErrorCase {
  error: AppError
  expected: HistoryErrorCategory | null
}

/**
 * These are the plain objects Tauri rejects with after `unwrap()` throws the
 * serialized Rust AppError. They intentionally are not Error instances.
 */
const appErrorCases = {
  database: {
    error: { kind: 'database', message: 'Failed to fetch while offline' },
    expected: 'server',
  },
  not_found: {
    error: { kind: 'not_found', message: 'Database network timeout (503)' },
    expected: 'unknown',
  },
  pool_busy: {
    error: { kind: 'pool_busy', message: 'Failed to fetch while offline' },
    expected: 'server',
  },
  conflict: {
    error: { kind: 'conflict', message: 'Database network timeout (503)' },
    expected: 'unknown',
  },
  migration: {
    error: { kind: 'migration', message: 'Database network timeout (503)' },
    expected: 'unknown',
  },
  io: {
    error: { kind: 'io', message: 'Database network timeout (503)' },
    expected: 'unknown',
  },
  json: {
    error: { kind: 'json', message: 'Database network timeout (503)' },
    expected: 'unknown',
  },
  ulid: {
    error: { kind: 'ulid', message: 'Database network timeout (503)' },
    expected: 'unknown',
  },
  invalid_operation: {
    error: { kind: 'invalid_operation', message: 'Database network timeout (503)' },
    expected: 'unknown',
  },
  channel: {
    error: { kind: 'channel', message: 'Database network timeout (503)' },
    expected: 'unknown',
  },
  internal: {
    error: { kind: 'internal', message: 'Failed to fetch while offline' },
    expected: 'server',
  },
  snapshot: {
    error: { kind: 'snapshot', message: 'Failed to fetch while offline' },
    expected: 'server',
  },
  validation: {
    error: { kind: 'validation', message: 'Database network timeout (503)' },
    expected: 'unknown',
  },
  non_reversible: {
    error: { kind: 'non_reversible', message: 'Database network timeout (503)' },
    expected: 'unknown',
  },
  cancelled: {
    error: { kind: 'cancelled', message: 'Failed to fetch while offline' },
    expected: null,
  },
} satisfies Record<AppErrorKind, AppErrorCase>

describe('categorizeHistoryError', () => {
  it.each(Object.entries(appErrorCases))(
    'classifies serialized %s by kind even when its message suggests another category',
    (_kind, { error, expected }) => {
      expect(error).not.toBeInstanceOf(Error)
      expect(categorizeHistoryError(error)).toBe(expected)
    },
  )

  it.each([
    new TypeError('Failed to fetch'),
    new Error('Network connection lost'),
    new Error('Request timeout'),
    new Error('Database returned 503 from sqlx'),
  ])('does not classify native Error message text %#', (error) => {
    expect(categorizeHistoryError(error)).toBe('unknown')
  })

  it('does not let HTTP-shaped fields override a serialized AppError kind', () => {
    const error = {
      kind: 'not_found',
      message: 'Failed to fetch from database while offline',
      status: 503,
      code: '504_GATEWAY_TIMEOUT',
    }

    expect(error).not.toBeInstanceOf(Error)
    expect(categorizeHistoryError(error)).toBe('unknown')
  })

  it('treats an unrecognised serialized kind as unknown at runtime', () => {
    expect(
      categorizeHistoryError({
        kind: 'kind_added_by_a_newer_backend',
        message: 'Failed to fetch while offline',
      }),
    ).toBe('unknown')
  })

  it.each([null, undefined, {}, { message: 'Database error', status: 503 }, 'opaque failure'])(
    'classifies non-AppError value %# as unknown',
    (error) => {
      expect(categorizeHistoryError(error)).toBe('unknown')
    },
  )
})
