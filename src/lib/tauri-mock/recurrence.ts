/**
 * The backend's recurrence date math, ported so the mock's edge into DONE makes
 * a task's next occurrence as the backend does (#6054 D3). Each function names
 * its Rust twin, so a change on one side can be found on the other:
 *
 * - `agaric_store::recurrence_math` (`src-tauri/agaric-store/src/recurrence_math.rs`):
 *   the one-interval shift, the rule normalization, the mode split, and the
 *   write-time grammar gate, which runs the shift rather than describing it;
 * - `agaric_engine::recurrence::parser::shift_date`: the three anchoring modes.
 *
 * The backend's `shift_date` reads `chrono::Local::now()`; this one takes the
 * moment as `now`, so a test can fix it.
 */

/** A calendar day, as a `chrono::NaiveDate` holds one. */
export interface Day {
  readonly year: number
  readonly month: number
  readonly day: number
}

/** `ShiftFailure`: a malformed interval, or arithmetic that leaves the calendar rail. */
export type ShiftFailure = 'interval' | 'overflow'

/** `shift_date`'s `Result<Option<String>, AppError>`: `ok: null` for a date or rule it cannot read. */
export type ShiftedDate = { readonly ok: string | null } | { readonly err: string }

/** `MIN_CALENDAR_YEAR..=MAX_CALENDAR_YEAR`: a shift landing outside it is an overflow. */
const MIN_CALENDAR_YEAR = 1900
const MAX_CALENDAR_YEAR = 2200

/** The year of `NaiveDate::MAX`. */
const MAX_DATE_YEAR = 262_142

/** `i64::MAX`: a longer count does not parse. */
const I64_MAX = 9_223_372_036_854_775_807n

/** `REPEAT_PROBE`: the day the grammar gate shifts to read a rule's verdict. */
const REPEAT_PROBE: Day = { year: 2000, month: 1, day: 1 }

/** The `++` catch-up's step budget. */
const PLUS_PLUS_MAX_STEPS = 10_000

/**
 * The day `day` of `monthIndex` (0-based) in `year`, normalized by the
 * platform's proleptic Gregorian calendar. A date it cannot hold comes back
 * with a `NaN` year, which no rail admits.
 */
function utcDay(year: number, monthIndex: number, day: number): Day {
  const d = new Date(0)
  d.setUTCFullYear(year, monthIndex, day)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/** `days_in_month`. */
export function daysInMonth(year: number, month: number): number {
  return utcDay(year, month, 0).day
}

/** `in_calendar_rail`. */
function inCalendarRail(d: Day): Day | null {
  return d.year >= MIN_CALENDAR_YEAR && d.year <= MAX_CALENDAR_YEAR ? d : null
}

/** `shift_by_days`. */
function shiftByDays(base: Day, days: number): Day | null {
  return inCalendarRail(utcDay(base.year, base.month - 1, base.day + days))
}

/** `shift_by_months`: the day clamped to the destination month's length. */
function shiftByMonths(base: Day, months: number): Day | null {
  const total = base.year * 12 + base.month - 1 + months
  const year = Math.floor(total / 12)
  if (!(year >= MIN_CALENDAR_YEAR && year <= MAX_CALENDAR_YEAR)) return null
  const month = total - year * 12 + 1
  return { year, month, day: Math.min(base.day, daysInMonth(year, month)) }
}

/**
 * `split_count_unit`: split before the last character, or null for fewer than
 * two (#5110). A Rust `char` is a code point, which `.` matches under `u`.
 */
function splitCountUnit(numUnit: string): { count: string; unit: string } | null {
  const split = /^(.+)(.)$/su.exec(numUnit)
  return split ? { count: split[1] as string, unit: split[2] as string } : null
}

/** `str::parse::<i64>`: an optional sign, then digits. A negative count is refused either way. */
function parseI64(s: string): number | null {
  if (!/^[+-]?\d+$/.test(s)) return null
  const n = BigInt(s)
  return n > I64_MAX ? null : Number(n)
}

/** `try_shift_date_once`: `base` moved one interval, or why not. */
export function tryShiftDateOnce(base: Day, interval: string): Day | ShiftFailure {
  switch (interval) {
    case 'daily': {
      return shiftByDays(base, 1) ?? 'overflow'
    }
    case 'weekly': {
      return shiftByDays(base, 7) ?? 'overflow'
    }
    case 'yearly': {
      return shiftByMonths(base, 12) ?? 'overflow'
    }
    // An arm of its own on the backend, which `shift_by_months(base, 1)`
    // answers the same. #679: the month-end clamp is sticky, as the next step
    // shifts the clamped day.
    case 'monthly': {
      return shiftByMonths(base, 1) ?? 'overflow'
    }
  }
  const split = splitCountUnit(interval.startsWith('+') ? interval.slice(1) : interval)
  if (split === null) return 'interval'
  const n = parseI64(split.count)
  if (n === null || n <= 0) return 'interval'
  switch (split.unit) {
    case 'd': {
      return shiftByDays(base, n) ?? 'overflow'
    }
    case 'w': {
      return shiftByDays(base, n * 7) ?? 'overflow'
    }
    case 'm': {
      return shiftByMonths(base, n) ?? 'overflow'
    }
    case 'y': {
      return shiftByMonths(base, n * 12) ?? 'overflow'
    }
    default: {
      return 'interval'
    }
  }
}

/** `shift_date_once`. */
export function shiftDateOnce(base: Day, interval: string): Day | null {
  const shifted = tryShiftDateOnce(base, interval)
  return typeof shifted === 'string' ? null : shifted
}

/** `normalize_repeat_rule`. */
export function normalizeRepeatRule(rule: string): string {
  return rule.trim().toLowerCase()
}

/** `split_repeat_rule`: the anchoring mode, and the interval after it. */
export function splitRepeatRule(
  normalized: string,
): ['dot_plus' | 'plus_plus' | 'default', string] {
  if (normalized.startsWith('.+')) return ['dot_plus', normalized.slice(2)]
  if (normalized.startsWith('++')) return ['plus_plus', normalized.slice(2)]
  return ['default', normalized]
}

/**
 * `validate_repeat_rule_shape` (#3647), the `repeat` gate `set_property` runs:
 * a rule is well formed unless its interval's shift is refused as malformed.
 * An overflow from the probe day is a property of that day, not of the rule.
 */
export function isValidRepeatRuleMock(rule: string): boolean {
  const normalized = normalizeRepeatRule(rule)
  if (normalized === '') return false
  const [, interval] = splitRepeatRule(normalized)
  return tryShiftDateOnce(REPEAT_PROBE, interval) !== 'interval'
}

/** `shift_date`'s read of a date: three numbers, `-`-separated, naming a real day. */
function parseDay(date: string): Day | null {
  const parts = date.split('-')
  if (parts.length !== 3 || !parts.every((part) => /^\+?\d+$/.test(part))) return null
  const [year, month, day] = parts.map(Number) as [number, number, number]
  if (year > MAX_DATE_YEAR || month < 1 || month > 12) return null
  return day >= 1 && day <= daysInMonth(year, month) ? { year, month, day } : null
}

function formatDay({ year, month, day }: Day): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function isAfter(a: Day, b: Day): boolean {
  return a.year * 10_000 + a.month * 100 + a.day > b.year * 10_000 + b.month * 100 + b.day
}

function okDay(day: Day | null): ShiftedDate {
  return { ok: day === null ? null : formatDay(day) }
}

/**
 * `shift_date`: `date` shifted by `rule`, from the date itself (`+`, or no
 * prefix), from today (`.+`), or stepped from the date until it passes today
 * (`++`). Only `++` can fail: when a step overflows, or the step budget runs
 * out before it catches up.
 */
export function shiftDate(date: string, rule: string, now: Date): ShiftedDate {
  const original = parseDay(date)
  if (original === null) return { ok: null }
  const today: Day = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() }
  const [mode, interval] = splitRepeatRule(normalizeRepeatRule(rule))
  if (mode === 'dot_plus') return okDay(shiftDateOnce(today, interval))
  if (mode === 'default') return okDay(shiftDateOnce(original, interval))
  let current = original
  for (let step = 0; step < PLUS_PLUS_MAX_STEPS; step++) {
    const next = tryShiftDateOnce(current, interval)
    // #3281: a malformed interval is skipped, as under the other two modes.
    if (next === 'interval') return { ok: null }
    if (next === 'overflow') {
      return {
        err: `recurrence ++ date arithmetic overflow: original=${formatDay(original)} interval=${interval} at=${formatDay(current)}`,
      }
    }
    current = next
    if (isAfter(current, today)) return okDay(current)
  }
  return {
    err: `recurrence ++ cap exceeded: original=${formatDay(original)} interval=${interval} today=${formatDay(today)}`,
  }
}
