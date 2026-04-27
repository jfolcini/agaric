import { describe, expect, it } from 'vitest'
import { i18n } from '../i18n'
import { formatRepeatLabel } from '../repeat-utils'

// Use the real i18n instance (initialized in test-setup.ts) so the test
// exercises actual translated strings from the `en` resource bundle.
const t = i18n.t.bind(i18n)

describe('formatRepeatLabel', () => {
  it('returns "daily" for standard daily', () => {
    expect(formatRepeatLabel('daily', t)).toBe('daily')
  })

  it('returns "weekly (from completion)" for .+weekly', () => {
    expect(formatRepeatLabel('.+weekly', t)).toBe('weekly (from completion)')
  })

  it('returns "monthly (catch-up)" for ++monthly', () => {
    expect(formatRepeatLabel('++monthly', t)).toBe('monthly (catch-up)')
  })

  it('returns "every 3 days" for +3d', () => {
    expect(formatRepeatLabel('+3d', t)).toBe('every 3 days')
  })

  it('returns "every 2 weeks" for 2w', () => {
    expect(formatRepeatLabel('2w', t)).toBe('every 2 weeks')
  })

  it('returns raw value for unknown format', () => {
    expect(formatRepeatLabel('custom-value', t)).toBe('custom-value')
  })

  it('returns "yearly" for standard yearly', () => {
    expect(formatRepeatLabel('yearly', t)).toBe('yearly')
  })

  it('returns empty string for empty input', () => {
    expect(formatRepeatLabel('', t)).toBe('')
  })

  it('returns "daily (from completion)" for .+daily', () => {
    expect(formatRepeatLabel('.+daily', t)).toBe('daily (from completion)')
  })

  it('returns "daily (catch-up)" for ++daily', () => {
    expect(formatRepeatLabel('++daily', t)).toBe('daily (catch-up)')
  })

  it('returns "every 1 month" for 1m (singular)', () => {
    expect(formatRepeatLabel('1m', t)).toBe('every 1 month')
  })

  it('returns "every 1 day" for 1d (singular)', () => {
    expect(formatRepeatLabel('1d', t)).toBe('every 1 day')
  })

  it('returns "every 1 week" for 1w (singular)', () => {
    expect(formatRepeatLabel('1w', t)).toBe('every 1 week')
  })

  // UX-7: Verify the function reads from the i18n bundle rather than
  // hardcoded English literals — swapping a key changes the output.
  it('uses translated strings from the i18n bundle', () => {
    const original = i18n.getResource('en', 'translation', 'repeat.daily') as string
    try {
      i18n.addResource('en', 'translation', 'repeat.daily', 'TODOS_OS_DIAS')
      expect(formatRepeatLabel('daily', t)).toBe('TODOS_OS_DIAS')
    } finally {
      i18n.addResource('en', 'translation', 'repeat.daily', original)
    }
  })
})
