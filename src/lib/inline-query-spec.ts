/**
 * Structured payload for inline `{{query …}}` blocks (P2 — inline-query
 * unification).
 *
 * Historically an inline query block stored a legacy flat text grammar after the
 * `{{query ` marker (`tag:work`, `property:k=v`, `type:backlinks target:…`),
 * parsed by `parseQueryExpression` and executed via the legacy per-type IPCs.
 * That grammar cannot express OR / NOT / nested groups / date ranges, which the
 * rich `run_advanced_query` engine (via `FilterExpr`) already supports.
 *
 * This module defines a VERSIONED structured payload so a block authored by the
 * nested builder can carry an arbitrary `FilterExpr`. The payload is the inner
 * text of `{{query <payload>}}`:
 *
 *   v2:<base64url(JSON)>
 *
 * `JSON` is an {@link InlineQuerySpec}. Two design constraints:
 *   1. **Markdown-safe.** The block content round-trips through the markdown
 *      serializer, which escapes `\ * ` ~ = [ ] #`. base64url (`A–Z a–z 0–9 - _`,
 *      no `+` `/` `=` padding) contains none of those, so the payload survives
 *      verbatim — unlike raw JSON, whose `[` `]` would be escaped.
 *   2. **Back-compat.** {@link decodeInlineQueryPayload} returns `null` for any
 *      non-`v2:` payload, so a legacy text block is left to the existing
 *      `parseQueryExpression` + legacy execution path UNCHANGED. New blocks use
 *      the structured form; old blocks keep rendering exactly as before.
 */

import type { FilterExpr } from './tauri'

/** The decoded structured payload of a `v2:` inline query block. */
export interface InlineQuerySpec {
  /** The compiled engine filter tree, run verbatim by `run_advanced_query`. */
  filter: FilterExpr
  /** Render matches as a table (vs. the default list). */
  table: boolean
}

/** Marker prefix that distinguishes a structured payload from legacy text. */
export const INLINE_QUERY_V2_PREFIX = 'v2:'

/** UTF-8 string → unpadded base64url (markdown-safe alphabet). */
function utf8ToBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/** Unpadded base64url → UTF-8 string (inverse of {@link utf8ToBase64Url}). */
function base64UrlToUtf8(b64url: string): string {
  const padded = b64url.replaceAll('-', '+').replaceAll('_', '/')
  // Re-add the `=` padding base64 needs (length up to the next multiple of 4).
  const fullLength = Math.ceil(padded.length / 4) * 4
  const binary = atob(padded.padEnd(fullLength, '='))
  const bytes = Uint8Array.from(binary, (c) => c.codePointAt(0) ?? 0)
  return new TextDecoder().decode(bytes)
}

/**
 * Serialize a spec into the inner payload of `{{query <payload>}}` (i.e. the
 * `v2:<base64url>` string, WITHOUT the surrounding delimiters). The caller wraps
 * it: `` `{{query ${encodeInlineQueryPayload(spec)}}}` ``.
 */
export function encodeInlineQueryPayload(spec: InlineQuerySpec): string {
  const json = JSON.stringify({
    filter: spec.filter,
    ...(spec.table ? { table: true } : {}),
  })
  return INLINE_QUERY_V2_PREFIX + utf8ToBase64Url(json)
}

/**
 * Parse the inner payload of a `{{query …}}` block. Returns the structured spec
 * for a well-formed `v2:` payload, or `null` for anything else — a legacy text
 * query, or a corrupt/garbled `v2:` payload — so the caller falls back to the
 * legacy `parseQueryExpression` path. Never throws.
 */
export function decodeInlineQueryPayload(payload: string): InlineQuerySpec | null {
  const trimmed = payload.trim()
  if (!trimmed.startsWith(INLINE_QUERY_V2_PREFIX)) return null
  try {
    const json = base64UrlToUtf8(trimmed.slice(INLINE_QUERY_V2_PREFIX.length))
    const parsed = JSON.parse(json) as Partial<InlineQuerySpec> | null
    if (parsed == null || typeof parsed !== 'object' || parsed.filter == null) return null
    return { filter: parsed.filter, table: parsed.table === true }
  } catch {
    return null
  }
}

/** True when a `{{query …}}` payload is the structured `v2:` form. */
export function isInlineQueryV2(payload: string): boolean {
  return payload.trim().startsWith(INLINE_QUERY_V2_PREFIX)
}

/** Count the leaf (single-primitive) conditions in a `FilterExpr` tree. */
export function countFilterLeaves(expr: FilterExpr): number {
  switch (expr.type) {
    case 'Leaf': {
      return 1
    }
    case 'Not': {
      return countFilterLeaves(expr.child)
    }
    default: {
      // And | Or — sum over children.
      return expr.children.reduce((sum, child) => sum + countFilterLeaves(child), 0)
    }
  }
}
