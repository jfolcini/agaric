/**
 * Tests for `markdown-parse.ts` behaviors not covered elsewhere.
 *
 * The bulk of `parse()` coverage lives in `markdown-serializer.test.ts` and
 * `markdown-serializer.property.test.ts`. This file pins behaviors that need
 * the logger mocked (FE-L-7: depth-limit truncation now emits a debug log).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { logger } from '../../lib/logger'
import { parse } from '../markdown-parse'

describe('parse — depth-limit truncation (FE-L-7)', () => {
  beforeEach(() => {
    vi.mocked(logger.debug).mockClear()
  })

  it('logs at debug level when depth exceeds MAX_PARSE_DEPTH', () => {
    // Calling parse with depth=11 directly trips the guard on the first
    // invocation, regardless of input shape.
    parse('> quoted', 11)

    expect(logger.debug).toHaveBeenCalledWith(
      'markdown-parse',
      'depth limit reached, truncating',
      expect.objectContaining({ depth: 11, maxDepth: 10, length: '> quoted'.length }),
    )
  })
})
