/**
 * Tauri mock — what a property value becomes under another type (#5841),
 * mirroring `agaric-engine/src/loro/coerce.rs`: the conversion a type change
 * applies to each value, and the one the SQL projection applies to a string
 * under its key's declared type. A leaf module, so `property-keys.ts` and
 * `property-type-change.ts` can both import it.
 */

import { isIsoDate } from '@/lib/search-query/is-iso-date'

/** `PropertyValue` as the engine holds it: a string (text, date or ref), a number or a boolean. */
export type HeldValue = string | number | boolean

/** Rust's `f64` grammar: a sign, digits with an optional point, an optional exponent. */
const RUST_F64 = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/
/** Rust's `str::trim`: Unicode White_Space, which takes U+0085 and not U+FEFF, unlike JS's. */
export const RUST_TRIM = /^\p{White_Space}+|\p{White_Space}+$/gu
/** `canonical_ulid`: Crockford base32, any case, no overflow. */
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i

/** What a string becomes under each type that does not take any string, or null. */
const STRING_COERCIONS: Readonly<Record<string, (s: string) => HeldValue | null>> = {
  number: (s) => {
    const trimmed = s.replace(RUST_TRIM, '')
    const n = Number(trimmed)
    return RUST_F64.test(trimmed) && Number.isFinite(n) ? n : null
  },
  date: (s) => (isIsoDate(s) ? s : null),
  boolean: (s) => (s === 'true' ? true : s === 'false' ? false : null),
  ref: (s) => (ULID.test(s) ? s.toUpperCase() : null),
}

/**
 * Rust's `f64` `Display`: the shortest digits that round-trip, never an
 * exponent, and a sign on `-0`.
 */
function rustF64Display(n: number): string {
  const [mantissa = '', exponent = '0'] = Math.abs(n).toExponential().split('e')
  const digits = mantissa.replace('.', '')
  const point = Number(exponent) + 1
  const sign = n < 0 || Object.is(n, -0) ? '-' : ''
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`
  if (point >= digits.length) return sign + digits + '0'.repeat(point - digits.length)
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`
}

/** `as_legacy_string`: a held value as text. */
export function heldText(value: HeldValue): string {
  return typeof value === 'number' ? rustF64Display(value) : String(value)
}

/**
 * `coerce`: the value `value` becomes under a definition of `to`, or null when
 * it does not fit. Select membership is the caller's.
 */
export function coerce(value: HeldValue, to: string): HeldValue | null {
  if (typeof value === 'string') {
    const coerceString = STRING_COERCIONS[to]
    return coerceString ? coerceString(value) : value
  }
  if (typeof value === 'number' && to === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean' && to === 'boolean') return value
  return Object.hasOwn(STRING_COERCIONS, to) ? null : heldText(value)
}
