/**
 * `spaceMoveFailureMessage` (#5841 S0.6): a move the backend refuses with its
 * own reason (the undo cap's "move fewer pages") shows that reason; anything
 * else shows the caller's fallback. The hook itself is driven end to end by
 * `SpaceMoveConfirmDialog.test.tsx`.
 */

import { describe, expect, it } from 'vitest'

import { spaceMoveFailureMessage } from '@/hooks/useSpaceMove'

const CAP =
  'undoing this move would take 1201 steps, its pages and the 1200 property values it removes, more than one undo can take; move fewer pages'

describe('spaceMoveFailureMessage', () => {
  it("shows a validation refusal's own reason", () => {
    expect(
      spaceMoveFailureMessage({ kind: 'validation', message: CAP }, 'Failed to move page'),
    ).toBe(CAP)
  })

  it('falls back for any other failure', () => {
    expect(spaceMoveFailureMessage(new Error('write failed'), 'Failed to move page')).toBe(
      'Failed to move page',
    )
    expect(
      spaceMoveFailureMessage(
        { kind: 'database', message: 'disk I/O error' },
        'Failed to move page',
      ),
    ).toBe('Failed to move page')
  })
})
