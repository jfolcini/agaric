/**
 * PEND-54 — One-shot registration of the core PEND-54 token kinds.
 *
 * Called from `parse()` so test harnesses (and the dev-server HMR
 * cycle) always see the canonical registry. Idempotent.
 */

import { validateGlob } from './glob-validate'
import { registerTokenPrefix } from './registry'
import type { FilterToken } from './types'

let registered = false

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
}
