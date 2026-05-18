/**
 * PEND-54 — One-shot registration of the core PEND-54 token kinds.
 *
 * Called from `parse()` so test harnesses (and the dev-server HMR
 * cycle) always see the canonical registry. Idempotent.
 *
 * PEND-53 — extends the registry with structured-metadata recognisers
 * (`state:`, `priority:`, `due:`, `scheduled:`, `prop:` + their `not-`
 * negations). The recognisers stay pure-functions; the chip projection
 * (`tokenSource` in `serialize.ts`) and the IPC projection
 * (`to-search-filter.ts`) extend in lock-step.
 */

import { validateGlob } from './glob-validate'
import { registerTokenPrefix } from './registry'
import type { DateOp, FilterToken, NamedDateRange } from './types'

let registered = false

/** Re-recognise an existing token (`xxx:value`) without sending it back
 * through the tokeniser — used by tests and snapshot fixtures.
 */
export function ensureRegistered(): void {
  if (registered) return
  registered = true

  // tag: — bare ALU/Unicode tag name, optional leading `#`. The
  // tag-name itself preserves Unicode (the plan calls this out
  // explicitly: `tag:#日本語`, `tag:#📌` must round-trip).
  registerTokenPrefix('tag:', (value, span) => {
    const cleaned = value.startsWith('#') ? value.slice(1) : value
    if (cleaned.length === 0) {
      return {
        kind: 'invalid',
        source: `tag:${value}`,
        error: 'tag: value required',
        span,
      } satisfies FilterToken
    }
    return { kind: 'tag', value: cleaned, span }
  })

  // path: — page-name glob include.
  registerTokenPrefix('path:', (value, span) => {
    if (value.length === 0) {
      return {
        kind: 'invalid',
        source: `path:${value}`,
        error: 'path: value required',
        span,
      } satisfies FilterToken
    }
    const err = validateGlob(value)
    if (err) {
      return {
        kind: 'invalid',
        source: `path:${value}`,
        error: err.message,
        span,
      } satisfies FilterToken
    }
    return { kind: 'pathInclude', value, span }
  })

  // not-path: — page-name glob exclude.
  registerTokenPrefix('not-path:', (value, span) => {
    if (value.length === 0) {
      return {
        kind: 'invalid',
        source: `not-path:${value}`,
        error: 'not-path: value required',
        span,
      } satisfies FilterToken
    }
    const err = validateGlob(value)
    if (err) {
      return {
        kind: 'invalid',
        source: `not-path:${value}`,
        error: err.message,
        span,
      } satisfies FilterToken
    }
    return { kind: 'pathExclude', value, span }
  })

  // PEND-53 — state: / not-state:
  registerTokenPrefix('state:', (value, span) => {
    if (value.length === 0) {
      return {
        kind: 'invalid',
        source: `state:${value}`,
        error: 'state: value required',
        span,
      }
    }
    return { kind: 'state', value, span }
  })
  registerTokenPrefix('not-state:', (value, span) => {
    if (value.length === 0) {
      return {
        kind: 'invalid',
        source: `not-state:${value}`,
        error: 'not-state: value required',
        span,
      }
    }
    return { kind: 'notState', value, span }
  })

  // PEND-53 — priority: / not-priority:
  registerTokenPrefix('priority:', (value, span) => {
    if (value.length === 0) {
      return {
        kind: 'invalid',
        source: `priority:${value}`,
        error: 'priority: value required',
        span,
      }
    }
    return { kind: 'priority', value, span }
  })
  registerTokenPrefix('not-priority:', (value, span) => {
    if (value.length === 0) {
      return {
        kind: 'invalid',
        source: `not-priority:${value}`,
        error: 'not-priority: value required',
        span,
      }
    }
    return { kind: 'notPriority', value, span }
  })

  // PEND-53 — due: / scheduled: share the date-value parser.
  registerTokenPrefix('due:', (value, span) => {
    return parseDateToken(value, span, 'due')
  })
  registerTokenPrefix('scheduled:', (value, span) => {
    return parseDateToken(value, span, 'scheduled')
  })

  // PEND-53 — prop:key=value / not-prop:key=value
  registerTokenPrefix('prop:', (value, span) => {
    return parsePropToken(value, span, 'prop')
  })
  registerTokenPrefix('not-prop:', (value, span) => {
    return parsePropToken(value, span, 'notProp')
  })
}

/**
 * Parse the value portion of a `due:` / `scheduled:` token.
 *
 * Accepted shapes (mirror the plan's "Inline token" table):
 *
 * - bucket keyword: `today`, `yesterday`, `overdue`, `this-week`,
 *   `this-month`, `next-week`, `older`, `none`
 * - absolute date (treated as `=YYYY-MM-DD`): `2026-05-17`
 * - comparison form: `<2026-06-01`, `<=2026-06-01`, `=2026-06-01`,
 *   `>=2026-01-01`, `>2026-01-01`
 *
 * Validation is strict: an unknown bucket keyword or an unparseable
 * date yields an `invalid` chip with an `InvalidDateFilter:` error
 * the frontend keys on (mirrors `InvalidGlob:` / `InvalidRegex:`).
 */
function parseDateToken(
  value: string,
  span: [number, number],
  kind: 'due' | 'scheduled',
): FilterToken {
  if (value.length === 0) {
    return {
      kind: 'invalid',
      source: `${kind}:${value}`,
      error: `${kind}: value required`,
      span,
    }
  }
  // Bucket keyword?
  const known: ReadonlyArray<NamedDateRange> = [
    'today',
    'yesterday',
    'overdue',
    'this-week',
    'this-month',
    'next-week',
    'older',
    'none',
  ]
  if ((known as readonly string[]).includes(value)) {
    return {
      kind,
      raw: value,
      value: { kind: 'named', name: value as NamedDateRange },
      span,
    }
  }
  // Comparison form? Operators (longest first to avoid `<` shadowing `<=`).
  const ops: ReadonlyArray<DateOp> = ['<=', '>=', '<', '>', '=']
  for (const op of ops) {
    if (value.startsWith(op)) {
      const rest = value.slice(op.length)
      if (!isIsoDate(rest)) {
        return {
          kind: 'invalid',
          source: `${kind}:${value}`,
          error: `InvalidDateFilter: expected YYYY-MM-DD after '${op}', got '${rest}'`,
          span,
        }
      }
      return {
        kind,
        raw: value,
        value: { kind: 'op', op, date: rest },
        span,
      }
    }
  }
  // Bare ISO date — treat as `=YYYY-MM-DD`.
  if (isIsoDate(value)) {
    return {
      kind,
      raw: value,
      value: { kind: 'op', op: '=', date: value },
      span,
    }
  }
  return {
    kind: 'invalid',
    source: `${kind}:${value}`,
    error: `InvalidDateFilter: unknown date '${value}'`,
    span,
  }
}

function isIsoDate(s: string): boolean {
  if (s.length !== 10) return false
  if (s[4] !== '-' || s[7] !== '-') return false
  for (let i = 0; i < s.length; i++) {
    if (i === 4 || i === 7) continue
    const c = s.charCodeAt(i)
    if (c < 0x30 || c > 0x39) return false
  }
  // Calendar-valid?
  const parts = s.split('-')
  const y = Number(parts[0])
  const m = Number(parts[1])
  const d = Number(parts[2])
  if (m < 1 || m > 12) return false
  if (d < 1 || d > 31) return false
  // Use Date for calendar validation (UTC parsing avoids TZ skew).
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/**
 * Parse the value portion of a `prop:` / `not-prop:` token.
 *
 * Shape: `key=value`. The `=` is mandatory (a bare `prop:key` falls
 * back to an invalid chip — the plan's "v1 always pairs key with
 * value" rule). An empty value (`prop:key=`) is permitted and matches
 * "block has this key at all" (documented in `docs/SEARCH.md`).
 */
function parsePropToken(
  value: string,
  span: [number, number],
  kind: 'prop' | 'notProp',
): FilterToken {
  if (value.length === 0) {
    return {
      kind: 'invalid',
      source: `${kind === 'prop' ? 'prop' : 'not-prop'}:${value}`,
      error: `${kind === 'prop' ? 'prop' : 'not-prop'}: key=value required`,
      span,
    }
  }
  const eq = value.indexOf('=')
  if (eq < 0) {
    return {
      kind: 'invalid',
      source: `${kind === 'prop' ? 'prop' : 'not-prop'}:${value}`,
      error: `${kind === 'prop' ? 'prop' : 'not-prop'}: expected 'key=value'`,
      span,
    }
  }
  const key = value.slice(0, eq)
  const propValue = value.slice(eq + 1)
  if (key.length === 0) {
    return {
      kind: 'invalid',
      source: `${kind === 'prop' ? 'prop' : 'not-prop'}:${value}`,
      error: `${kind === 'prop' ? 'prop' : 'not-prop'}: key cannot be empty`,
      span,
    }
  }
  return { kind, key, value: propValue, span }
}
