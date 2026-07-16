/**
 * One-shot registration of the core token kinds.
 *
 * Called from `parse()` so test harnesses (and the dev-server HMR
 * cycle) always see the canonical registry. Idempotent.
 *
 * Extends the registry with structured-metadata recognisers
 * (`state:`, `priority:`, `due:`, `scheduled:`, `prop:` + their `not-`
 * negations). The recognisers stay pure-functions; the chip projection
 * (`tokenSource` in `serialize.ts`) and the IPC projection
 * (`to-search-filter.ts`) extend in lock-step.
 */

import { TASK_STATES } from '@/lib/filter-dimension-metadata'
import { getPriorityLevels } from '@/lib/priority-levels'
import { validateGlob } from '@/lib/search-query/glob-validate'
import { isIsoDate } from '@/lib/search-query/is-iso-date'
import { registerTokenPrefix, type ValueParser } from '@/lib/search-query/registry'
import type { DateOp, FilterToken, NamedDateRange } from '@/lib/search-query/types'
import { prefixed, ValidationCode } from '@/lib/search-query/validation-codes'

let registered = false

/**
 * #2276 — validate a `state:` / `priority:` value against the shared
 * vocabulary. An out-of-vocabulary value (`state:BOGUS`, `priority:banana`)
 * must surface as an `invalid` chip rather than a false-valid green one that
 * projects a never-matching value to the IPC wire — mirroring how `due:` /
 * `path:` reject unknown values. The `none` sentinel is accepted
 * case-insensitively for parity with the `due:` parser (and the backend, which
 * treats the `none` sentinel case-insensitively).
 *
 * Todo states are a fixed vocabulary (`TASK_STATES`); priority levels are
 * user-configurable, so we read the live levels at parse time via
 * `getPriorityLevels()`.
 */
function isKnownState(value: string): boolean {
  if (value.toLowerCase() === 'none') return true
  return TASK_STATES.includes(value)
}

function isKnownPriority(value: string): boolean {
  if (value.toLowerCase() === 'none') return true
  return getPriorityLevels().includes(value)
}

/**
 * Factory for the `state:` / `not-state:` / `priority:` / `not-priority:`
 * recogniser family — four token prefixes that share one shape: reject an
 * empty value, reject an out-of-vocabulary value, otherwise emit a
 * `{ kind, value, span }` token. Single-sourced here so the empty-value
 * contract and the `unknown <noun>` message can only be edited in one place
 * (previously four near-identical 10-line blocks that drifted independently).
 *
 * `prefix` is the full token prefix including the trailing `:` (e.g.
 * `state:`), so it reconstructs both the `source` (`${prefix}${value}`) and
 * the `<prefix> value required` copy. `noun` is the display word in the
 * unknown-value error (`state` / `priority`).
 */
function simpleValueRecogniser<K extends 'state' | 'notState' | 'priority' | 'notPriority'>(
  prefix: string,
  kind: K,
  noun: string,
  isKnown: (value: string) => boolean,
): ValueParser {
  return (value, span) => {
    if (value.length === 0) {
      return {
        kind: 'invalid',
        source: `${prefix}${value}`,
        error: `${prefix} value required`,
        span,
      }
    }
    if (!isKnown(value)) {
      return {
        kind: 'invalid',
        source: `${prefix}${value}`,
        error: `unknown ${noun} '${value}'`,
        span,
      }
    }
    return { kind, value, span }
  }
}

/**
 * #152 / #718 — strip one surrounding `"..."` pair from a filter value.
 * The tokeniser keeps a mid-word quoted phrase as part of the word
 * (e.g. `path:"Meeting Notes/*"` reaches the recogniser as a single
 * token), so the recogniser only needs to peel the quotes. Both quotes
 * must be present; an unmatched leading `"` stays a literal.
 */
function stripSurroundingQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
  }
  return value
}

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

  // path: — page-name glob include. #718 — `path:"glob with spaces"`
  // strips the surrounding quotes (mirrors prop:'s #152 rule), so page
  // titles containing whitespace round-trip through serialise/parse.
  registerTokenPrefix('path:', (value, span) => {
    const glob = stripSurroundingQuotes(value)
    if (glob.length === 0) {
      return {
        kind: 'invalid',
        source: `path:${value}`,
        error: 'path: value required',
        span,
      } satisfies FilterToken
    }
    const err = validateGlob(glob)
    if (err) {
      return {
        kind: 'invalid',
        source: `path:${value}`,
        error: err.message,
        span,
      } satisfies FilterToken
    }
    return { kind: 'pathInclude', value: glob, span }
  })

  // not-path: — page-name glob exclude. #718 — quoted form accepted,
  // same as path:.
  registerTokenPrefix('not-path:', (value, span) => {
    const glob = stripSurroundingQuotes(value)
    if (glob.length === 0) {
      return {
        kind: 'invalid',
        source: `not-path:${value}`,
        error: 'not-path: value required',
        span,
      } satisfies FilterToken
    }
    const err = validateGlob(glob)
    if (err) {
      return {
        kind: 'invalid',
        source: `not-path:${value}`,
        error: err.message,
        span,
      } satisfies FilterToken
    }
    return { kind: 'pathExclude', value: glob, span }
  })

  // State: / not-state: / priority: / not-priority: — one shared factory
  // (see `simpleValueRecogniser`) so the empty-value contract and the
  // `unknown <noun>` copy live in a single place.
  registerTokenPrefix('state:', simpleValueRecogniser('state:', 'state', 'state', isKnownState))
  registerTokenPrefix(
    'not-state:',
    simpleValueRecogniser('not-state:', 'notState', 'state', isKnownState),
  )
  registerTokenPrefix(
    'priority:',
    simpleValueRecogniser('priority:', 'priority', 'priority', isKnownPriority),
  )
  registerTokenPrefix(
    'not-priority:',
    simpleValueRecogniser('not-priority:', 'notPriority', 'priority', isKnownPriority),
  )

  // Due: / scheduled: share the date-value parser.
  registerTokenPrefix('due:', (value, span) => parseDateToken(value, span, 'due'))
  registerTokenPrefix('scheduled:', (value, span) => parseDateToken(value, span, 'scheduled'))

  // Prop:key=value / not-prop:key=value
  registerTokenPrefix('prop:', (value, span) => parsePropToken(value, span, 'prop'))
  registerTokenPrefix('not-prop:', (value, span) => parsePropToken(value, span, 'notProp'))
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
 * date yields an `invalid` chip whose error text carries the shared
 * `InvalidDateFilter: ` display label (mirrors `InvalidGlob` / `InvalidRegex`;
 * display copy only since #2251 — IPC errors carry a structured code).
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
  // The `none` sentinel is accepted case-insensitively for
  // parity with `state:NONE` / `priority:NONE` (the backend treats the
  // date `none` sentinel case-insensitively too). We normalise to the
  // canonical lowercase `none` so the chip and the wire value agree.
  // Other bucket keywords stay case-sensitive — they are a fixed,
  // lowercase vocabulary.
  if (value.toLowerCase() === 'none') {
    return {
      kind,
      raw: value,
      value: { kind: 'named', name: 'none' },
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
          error: prefixed(
            ValidationCode.InvalidDateFilter,
            `expected YYYY-MM-DD after '${op}', got '${rest}'`,
          ),
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
    error: prefixed(ValidationCode.InvalidDateFilter, `unknown date '${value}'`),
    span,
  }
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
  // Display prefix for this token family — computed once instead of
  // reconstructing `kind === 'prop' ? 'prop' : 'not-prop'` at every
  // error site below.
  const label = kind === 'prop' ? 'prop' : 'not-prop'
  if (value.length === 0) {
    return {
      kind: 'invalid',
      source: `${label}:${value}`,
      error: `${label}: key=value required`,
      span,
    }
  }
  const eq = value.indexOf('=')
  if (eq < 0) {
    return {
      kind: 'invalid',
      source: `${label}:${value}`,
      error: `${label}: expected 'key=value'`,
      span,
    }
  }
  const key = value.slice(0, eq)
  let propValue = value.slice(eq + 1)
  if (key.length === 0) {
    return {
      kind: 'invalid',
      source: `${label}:${value}`,
      error: `${label}: key cannot be empty`,
      span,
    }
  }
  // #152 — `prop:key="value with spaces"`: strip the surrounding
  // quotes (shared helper; see `stripSurroundingQuotes`).
  propValue = stripSurroundingQuotes(propValue)
  return { kind, key, value: propValue, span }
}
