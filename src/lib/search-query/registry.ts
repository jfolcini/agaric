/**
 * PEND-54 — Token recogniser registry.
 *
 * A recogniser is a pure function `(rawValue: string, valueSpan) ->
 * FilterToken`. The parser splits the input into whitespace-delimited
 * raw tokens and asks each registered prefix recogniser whether the
 * token belongs to it. The first matching prefix wins. Unknown
 * prefix-shaped tokens (e.g. `unknown:foo`) are surfaced as `invalid`.
 *
 * PEND-53 will register new prefixes (`state:`, `priority:`, `due:`,
 * `scheduled:`, `prop:`, `not-prop:`) here without touching
 * `tokenize.ts` or `classify.ts`.
 */

import type { FilterToken } from './types'

/**
 * Parse a token's `value` portion into a concrete `FilterToken`.
 *
 * `value` is the raw text *after* the prefix has been stripped (e.g.
 * for the registration `prefix='tag:'` and input `'tag:#urgent'`,
 * `value` is `'#urgent'`). `span` is the absolute `[start, end)` span
 * of the **whole** token (prefix included) in the original input.
 */
export type ValueParser = (value: string, span: [number, number]) => FilterToken

interface Registration {
  prefix: string
  parse: ValueParser
}

const registrations: Registration[] = []

/**
 * Register a token prefix. Prefixes are matched longest-first at parse
 * time so `not-path:` wins over a hypothetical `not-`.
 */
export function registerTokenPrefix(prefix: string, parse: ValueParser): void {
  if (!prefix.endsWith(':')) {
    throw new Error(`token prefix must end with ':'; got '${prefix}'`)
  }
  if (registrations.some((r) => r.prefix === prefix)) {
    // Idempotent registration so HMR / test re-imports don't double-add.
    return
  }
  registrations.push({ prefix, parse })
  registrations.sort((a, b) => b.prefix.length - a.prefix.length)
}

/** Returns the list of registered prefixes (longest-first). */
export function getRegisteredPrefixes(): readonly string[] {
  return registrations.map((r) => r.prefix)
}

/**
 * Try to match a raw token against the registered prefixes.
 *
 * `raw` is the whole token text (e.g. `'tag:#urgent'`). `span` is the
 * absolute `[start, end)` of `raw` in the original input.
 *
 * Returns the produced `FilterToken` (concrete or invalid) on a prefix
 * hit; returns `null` if the token doesn't look like any registered
 * prefix.
 */
export function recognise(raw: string, span: [number, number]): FilterToken | null {
  for (const r of registrations) {
    if (raw.startsWith(r.prefix)) {
      const value = raw.slice(r.prefix.length)
      return r.parse(value, span)
    }
  }
  return null
}

/**
 * Detect a token that *looks* like a prefix call (`foo:bar`) but isn't
 * registered. Used to surface "unknown filter key" as an `invalid`
 * chip instead of silently dropping it into free-text.
 *
 * A bare `:` not preceded by a recognised identifier is treated as
 * ordinary free-text (e.g. URLs, time literals).
 */
export function looksLikeUnknownPrefix(raw: string): { key: string } | null {
  // Identifier: ASCII letters / digits / `-`. Real prefixes never
  // contain spaces. A leading `not-` is allowed (already a real
  // convention here: `not-path:`).
  const m = /^([a-zA-Z][a-zA-Z0-9-]*):/.exec(raw)
  if (!m?.[1]) return null
  // DSL-10: a pasted URL (`http://…`, `https://…`, `file://…`) matches
  // the `key:` shape but is not a filter — the `:` is immediately
  // followed by `//`. Treat it as ordinary free-text instead of an
  // invalid chip so the URL isn't silently stripped from the query.
  if (raw.slice(m[0].length).startsWith('//')) return null
  return { key: m[1] }
}

/** Test-only: wipe the registry. Production code never calls this. */
export function _resetRegistryForTests(): void {
  registrations.length = 0
}
