/**
 * The `datetime` property value (#6758): an instant stored in UTC as the
 * fixed-width canonical string `YYYY-MM-DDTHH:MMZ` (minutes, no seconds) in
 * `value_date`, shown and edited in the device's time zone. The backend's
 * reader follows the same rules as {@link parseDatetimeInput}; keep them
 * identical.
 */

import { isIsoDate } from '@/lib/search-query/is-iso-date'

const CANONICAL = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})Z$/
const INPUT = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/
const TIME = /^\d{2}:\d{2}$/

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** `y-m-d` of an ISO day the caller checked, as numbers. */
function dayParts(day: string): [number, number, number] {
  return day.split('-').map(Number) as [number, number, number]
}

/** The canonical string of a UTC instant, its seconds dropped. */
function canonicalOf(at: Date): string {
  return (
    `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}` +
    `T${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}Z`
  )
}

/** The local day of an instant, `YYYY-MM-DD`. */
function localDayOf(at: Date): string {
  return `${pad(at.getFullYear(), 4)}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/** A local wall time: `setFullYear`, unlike the constructor, does not read years 0-99 as 1900s. */
function localDate(day: string, hours: number, minutes: number): Date {
  const [y, m, d] = dayParts(day)
  const at = new Date(2000, 0, 1, 0, 0, 0, 0)
  at.setFullYear(y, m - 1, d)
  at.setHours(hours, minutes, 0, 0)
  return at
}

/** Whether `s` is a stored datetime: `YYYY-MM-DDTHH:MMZ`, a real day and time. */
export function isCanonicalDatetime(s: string): boolean {
  const m = CANONICAL.exec(s)
  return m !== null && isIsoDate(m[1] as string) && Number(m[2]) < 24 && Number(m[3]) < 60
}

/**
 * The canonical value a typed datetime names, or null. Takes `YYYY-MM-DD`,
 * `T` or one space, `HH:MM`, optional `:SS` (dropped), optional `Z` or
 * `±HH:MM`; without a zone the time is the device's. A day alone is no
 * datetime, and a local time the clocks skipped names no instant.
 */
export function parseDatetimeInput(text: string): string | null {
  const m = INPUT.exec(text)
  if (m === null) return null
  const [, day, hh, mm, ss, zone] = m as unknown as [
    string,
    string,
    string,
    string,
    string?,
    string?,
  ]
  const hours = Number(hh)
  const minutes = Number(mm)
  if (!isIsoDate(day) || hours > 23 || minutes > 59 || (ss !== undefined && Number(ss) > 59)) {
    return null
  }
  if (zone === undefined) {
    const at = localDate(day, hours, minutes)
    const kept = localDayOf(at) === day && at.getHours() === hours && at.getMinutes() === minutes
    return kept ? canonicalOf(at) : null
  }
  let offset = 0
  if (zone !== 'Z') {
    const oh = Number(zone.slice(1, 3))
    const om = Number(zone.slice(4, 6))
    if (oh > 23 || om > 59) return null
    offset = (zone.startsWith('-') ? -1 : 1) * (oh * 60 + om)
  }
  const [y, mo, d] = dayParts(day)
  const at = new Date(0)
  at.setUTCFullYear(y, mo - 1, d)
  at.setUTCHours(hours, minutes - offset, 0, 0)
  return canonicalOf(at)
}

/** A canonical value's day and time in the device's time zone. */
export function datetimeToLocalParts(canonical: string): { date: string; time: string } {
  const at = new Date(canonical)
  return { date: localDayOf(at), time: `${pad(at.getHours())}:${pad(at.getMinutes())}` }
}

/** The canonical value of a device-local day and `HH:MM` time, or null. */
export function localPartsToDatetime(date: string, time: string): string | null {
  return TIME.test(time) ? parseDatetimeInput(`${date}T${time}`) : null
}

/** A value as a chip shows it: a datetime as its local `YYYY-MM-DD HH:MM`, anything else as is. */
export function formatDatetimeForDisplay(value: string): string {
  if (!isCanonicalDatetime(value)) return value
  const { date, time } = datetimeToLocalParts(value)
  return `${date} ${time}`
}

/**
 * A canonical value as its local time with that moment's offset,
 * `YYYY-MM-DDTHH:MM±HH:MM`, as Markdown writes it and as a type change to
 * text or url leaves it.
 */
export function formatDatetimeWithOffset(canonical: string): string {
  const { date, time } = datetimeToLocalParts(canonical)
  const offset = -new Date(canonical).getTimezoneOffset()
  const abs = Math.abs(offset)
  return `${date}T${time}${offset < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/**
 * The canonical value of a local day's first instant: midnight, or the first
 * minute after a skipped one. A day-only operand on a datetime key is the
 * local day `[localDayStartUtc(day), localDayStartUtc(next day))`.
 */
export function localDayStartUtc(day: string): string {
  return canonicalOf(localDate(day, 0, 0))
}
