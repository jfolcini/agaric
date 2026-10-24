/**
 * The mock's port of the backend's recurrence date math (`../recurrence.ts`),
 * checked against the vectors the backend's own tests assert. Inputs and
 * expected outputs are copied from `src-tauri/agaric-engine/src/recurrence/mod.rs`
 * (`tests`), `src-tauri/agaric-engine/src/recurrence/parser.rs` (`tests_m80`,
 * `repeat_rule_validation_tests_3647`), `src-tauri/agaric-store/src/recurrence_math.rs`
 * (`repeat_rule_shape_tests`) and `src-tauri/src/recurrence/tests.rs`. Where
 * the Rust test reads `chrono::Local::now()`, this one passes a fixed `NOW`.
 */

import { describe, expect, it } from 'vitest'

import {
  type Day,
  daysInMonth,
  isValidRepeatRuleMock,
  normalizeRepeatRule,
  shiftDate,
  shiftDateOnce,
  splitRepeatRule,
  tryShiftDateOnce,
} from '@/lib/tauri-mock/recurrence'

/** Noon, so no daylight-saving change moves the day. */
const NOW = new Date(2026, 9, 24, 12)

function day(iso: string): Day {
  const [year, month, d] = iso.split('-').map(Number) as [number, number, number]
  return { year, month, day: d }
}

/** The day `n` days from `NOW`'s, as the Rust tests offset `chrono::Local::now()`. */
function fromToday(n: number): string {
  const d = new Date(NOW)
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const shift = (date: string, rule: string) => shiftDate(date, rule, NOW)

describe('shift_date', () => {
  it('shifts from the date itself under the default mode', () => {
    expect(shift('2025-06-15', 'daily')).toEqual({ ok: '2025-06-16' })
    expect(shift('2025-06-15', 'weekly')).toEqual({ ok: '2025-06-22' })
    expect(shift('2025-06-15', '+3d')).toEqual({ ok: '2025-06-18' })
  })

  it('shifts from today under `.+`', () => {
    expect(shift('2020-01-01', '.+weekly')).toEqual({ ok: fromToday(7) })
    expect(shift('2020-01-01', '.+daily')).toEqual({ ok: fromToday(1) })
    expect(shift('2020-01-01', '.+3d')).toEqual({ ok: fromToday(3) })
  })

  it('steps a past date until it passes today under `++`', () => {
    // The Rust test bounds this to (today, today + 7]; 21 days back, weekly,
    // the fourth step is the first past today.
    expect(shift(fromToday(-21), '++weekly')).toEqual({ ok: fromToday(7) })
    expect(shift(fromToday(-10), '++daily')).toEqual({ ok: fromToday(1) })
    expect(shift(fromToday(-5), '++1d')).toEqual({ ok: fromToday(1) })
  })

  it('refuses a `++` rule whose step budget runs out before today', () => {
    const veryOld = shift(fromToday(-11_000), '++1d')
    expect(veryOld).toEqual({ err: expect.stringContaining('cap exceeded') })
    expect(veryOld).toEqual({ err: expect.stringContaining('interval=1d') })
    expect(shift('1900-01-01', '++1d')).toEqual({ err: expect.stringContaining('cap exceeded') })
  })

  it('refuses a `++` step that leaves the calendar rail', () => {
    const overflow = shift('2150-01-15', '++100y')
    expect(overflow).toEqual({ err: expect.stringContaining('arithmetic overflow') })
    expect(overflow).toEqual({ err: expect.stringContaining('interval=100y') })
    expect(shift('262142-01-01', '++1y')).toEqual({
      err: expect.stringContaining('arithmetic overflow'),
    })
  })

  it.each(['++2weeks', '++xyz', '++0d', '++-3d', '++5x', '++w'])(
    'skips the malformed `++` interval %j rather than refusing it (#3281)',
    (rule) => {
      expect(shift('2026-08-01', rule)).toEqual({ ok: null })
    },
  )

  it('shifts an unreadable date or rule to nothing', () => {
    expect(shift('not-a-date', 'daily')).toEqual({ ok: null })
    expect(shift('2025-06-15', 'xyz')).toEqual({ ok: null })
    expect(shift('2025-06-15', '')).toEqual({ ok: null })
  })

  it('shifts `yearly` by a year, clamping Feb 29 (#3281)', () => {
    expect(shift('2026-08-01', 'yearly')).toEqual({ ok: '2027-08-01' })
    expect(shift('2024-02-29', 'yearly')).toEqual({ ok: '2025-02-28' })
  })

  it('shifts `monthly` to the same day, clamped to the month, across a year end', () => {
    expect(shift('2025-01-31', 'monthly')).toEqual({ ok: '2025-02-28' })
    expect(shift('2025-06-15', 'monthly')).toEqual({ ok: '2025-07-15' })
    expect(shift('2025-12-15', 'monthly')).toEqual({ ok: '2026-01-15' })
    expect(shift('2025-12-31', 'monthly')).toEqual({ ok: '2026-01-31' })
  })

  it('keeps the clamped day on the next step (#679)', () => {
    expect(shift('2025-01-31', 'monthly')).toEqual({ ok: '2025-02-28' })
    expect(shift('2025-02-28', 'monthly')).toEqual({ ok: '2025-03-28' })
    expect(shift('2025-03-28', 'monthly')).toEqual({ ok: '2025-04-28' })
  })

  it.each([
    ['2025-04-26', '+1y', '2026-04-26'],
    ['2024-02-29', '+1y', '2025-02-28'],
    ['2028-02-29', '+4y', '2032-02-29'],
    ['2024-02-29', '+4y', '2028-02-29'],
    ['2025-12-31', '+2y', '2027-12-31'],
    ['2025-04-26', '+0y', null],
    ['2025-04-26', '+-1y', null],
    ['2025-04-26', '+abcy', null],
  ])('shifts %s by %s to %s', (date, rule, expected) => {
    expect(shift(date, rule)).toEqual({ ok: expected })
  })

  it.each([
    '-1d',
    '-1w',
    '-1m',
    '-3w',
    '-2m',
    '-7d',
    '0d',
    '0w',
    '0m',
    '+0d',
    '+0w',
    '+0m',
    '5x',
    'w',
    '3.5d',
    'invalid',
  ])('shifts nowhere under the non-positive or malformed interval %j', (rule) => {
    expect(shift('2025-06-15', rule)).toEqual({ ok: null })
  })
})

describe('shift_date_once', () => {
  it('knows the length of each month', () => {
    expect(daysInMonth(2025, 1)).toBe(31)
    expect(daysInMonth(2025, 2)).toBe(28)
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2025, 4)).toBe(30)
    expect(daysInMonth(2025, 12)).toBe(31)
  })

  it('clamps a month-end day and rolls December into January', () => {
    expect(shiftDateOnce(day('2025-01-31'), 'monthly')).toEqual(day('2025-02-28'))
    expect(shiftDateOnce(day('2025-12-31'), 'monthly')).toEqual(day('2026-01-31'))
  })

  it('shifts by a count of days, weeks or months', () => {
    expect(shiftDateOnce(day('2025-06-15'), '3d')).toEqual(day('2025-06-18'))
    expect(shiftDateOnce(day('2025-06-15'), '2w')).toEqual(day('2025-06-29'))
    expect(shiftDateOnce(day('2025-06-15'), '2m')).toEqual(day('2025-08-15'))
    expect(shiftDateOnce(day('2026-01-15'), '3m')).toEqual(day('2026-04-15'))
    expect(shiftDateOnce(day('2026-11-15'), '3m')).toEqual(day('2027-02-15'))
  })

  it.each([
    ['2024-03-30', 'daily', '2024-03-31'],
    ['2024-03-30', 'weekly', '2024-04-06'],
    ['2024-10-26', 'daily', '2024-10-27'],
    ['2024-10-26', 'weekly', '2024-11-02'],
    ['2024-03-08', '+3d', '2024-03-11'],
    ['2024-11-01', '+3d', '2024-11-04'],
    ['2024-10-05', 'weekly', '2024-10-12'],
    ['2024-04-07', 'monthly', '2024-05-07'],
    ['2025-03-08', '+2d', '2025-03-10'],
    ['2024-10-05', '+2d', '2024-10-07'],
  ])('shifts %s by %s to %s whatever the daylight-saving changes', (base, rule, expected) => {
    expect(shiftDateOnce(day(base), rule)).toEqual(day(expected))
  })

  it('refuses a shift that leaves the calendar rail (#1887)', () => {
    expect(shiftDateOnce(day('2025-06-15'), '100000m')).toBeNull()
    expect(shiftDateOnce(day('2025-06-15'), '-100000m')).toBeNull()
    expect(shiftDateOnce(day('1900-01-01'), '20000w')).toBeNull()
    expect(shiftDateOnce(day('2200-12-01'), 'monthly')).toBeNull()
    expect(shiftDateOnce(day('2000-01-01'), '+9999999999d')).toBeNull()
  })
})

describe('the `repeat` grammar gate (#3647)', () => {
  /** `repeat_rule_validation_tests_3647::CORPUS`. */
  const CORPUS = [
    'daily',
    'weekly',
    'monthly',
    'yearly',
    '+1d',
    '+3d',
    '+2w',
    '+6m',
    '+1y',
    '1d',
    '3w',
    '2m',
    '1y',
    '.+daily',
    '.+weekly',
    '.+monthly',
    '.+yearly',
    '.+1d',
    '.+3w',
    '.+2m',
    '++daily',
    '++weekly',
    '++monthly',
    '++yearly',
    '++1d',
    '++2w',
    '++6m',
    '  daily  ',
    'DAILY',
    '++2W',
    '',
    '   ',
    '+',
    '++',
    '.+',
    '+daily',
    '+weekly',
    '+yearly',
    '++ 1d',
    '.+ 1w',
    '2 w',
    '+0d',
    '0w',
    '-1d',
    '+-3w',
    '3.5d',
    '5x',
    '1é',
    '.+1¶',
    '12q',
    'w',
    '+d',
    'invalid',
    '++2weeks',
    'FREQ=DAILY',
    'every day',
  ]

  it.each(CORPUS)('accepts %j exactly when the shift honours it', (rule) => {
    const shifted = shift(fromToday(-1), rule)
    expect(isValidRepeatRuleMock(rule)).toBe('ok' in shifted && shifted.ok !== null)
  })

  it.each([
    'daily',
    'weekly',
    'monthly',
    'yearly',
    '.+daily',
    '.+weekly',
    '.+monthly',
    '++daily',
    '++weekly',
    '++monthly',
    '+3d',
    '3d',
    '+2w',
    '2w',
    '+2m',
    '2m',
    '+2y',
    '2y',
    '.+1w',
    '++1d',
  ])('accepts %j, which the shipped UI writes', (rule) => {
    expect(isValidRepeatRuleMock(rule)).toBe(true)
  })

  it.each(['  daily  ', 'DAILY', '  ++2W', '\t.+Monthly\n'])('normalizes %j', (rule) => {
    expect(isValidRepeatRuleMock(rule)).toBe(true)
  })

  it.each(['+199y', '+9999m', '++500y', '.+2000w'])(
    'accepts %j, whose shift overflows only from some days',
    (rule) => {
      expect(isValidRepeatRuleMock(rule)).toBe(true)
    },
  )

  it('overflows the probe day on `9999m`', () => {
    expect(tryShiftDateOnce(day('2000-01-01'), '9999m')).toBe('overflow')
  })

  it.each([
    'daily',
    '+1d',
    '12w',
    '++10d',
    '',
    '+',
    '++ 1d',
    '-1d',
    '3.5d',
    '5x',
    '++2weeks',
    'é',
    '1é',
    '+1é',
    '.+1¶',
  ])('reads %j as malformed or not from every base day alike', (rule) => {
    const [, interval] = splitRepeatRule(normalizeRepeatRule(rule))
    const verdicts = ['2000-01-01', '1900-01-01', '2024-02-29', '2200-12-31', '2100-06-15'].map(
      (base) => tryShiftDateOnce(day(base), interval) === 'interval',
    )
    expect(new Set(verdicts).size).toBe(1)
  })
})
