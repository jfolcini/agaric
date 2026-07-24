/**
 * inline-property-parse — pure parser for inline `key:: value` property lines
 * typed directly into a block (#2675).
 *
 * The `::` property picker inserts `key:: ` inline text; before this module
 * nothing ever parsed the typed value back OUT of the block at save time, so
 * the documented "pick a key, type its value, it commits" flow silently left
 * the text literal and wrote no property. The block-flush path
 * (`use-block-flush.ts`) now runs this parser on save and commits each parsed
 * property via the typed property API, stripping a property line from the
 * committed content ONLY after its write succeeds.
 *
 * The line-level semantics deliberately mirror the Logseq import parser
 * (`src-tauri/src/import.rs::parse_logseq_markdown`) so inline entry and file
 * import agree on what a property line IS:
 *
 *   - A line is a property line when, after trimming, it splits at the FIRST
 *     `":: "` occurrence into a valid key and a non-empty value.
 *   - Keys match the same alphabet `op::validate_set_property` enforces:
 *     `^[A-Za-z0-9_-]{1,64}$` (see `is_property_key` in import.rs). Free-form
 *     text containing `:: ` mid-sentence (URLs, prose, `std::vector`) never
 *     matches because the LHS is not a valid key or there is no `":: "`.
 *   - `key::` / `key:: ` with no value is NOT a property line — the text
 *     stays literal, matching the backend's rejection of empty values.
 *     (Near-DIVERGENCE nuance: import.rs sees `key::` as content — no
 *     `":: "` separator — but `key:: ` with a trailing space DOES split
 *     there, yielding an empty value the backend then rejects. Here both
 *     forms stay literal, which is the only non-lossy option at save time.)
 *   - Reserved / exporter-managed keys (`FRONTMATTER_RESERVED_KEYS` in
 *     import.rs, e.g. `space`, `template`) are never parsed. DIVERGENCE from
 *     import.rs: import DROPS such lines (round-trip filter); here the line
 *     stays literal instead — silently deleting text a user just typed would
 *     be data loss, while an imported file's reserved lines are
 *     exporter-noise by construction.
 *   - Lines inside fenced code blocks (``` delimiters) are never property
 *     lines, mirroring import.rs's `line_is_code` guard.
 *   - HARD BREAKS: block content arrives SERIALIZED (see
 *     `markdown-serialize.ts`), where a Shift+Enter hard break is a trailing
 *     `\` before the newline and a LITERAL backslash is escaped to `\\`. A
 *     non-final line therefore ends with an odd trailing-backslash run whose
 *     final `\` is the break marker, never value text — it is dropped before
 *     parsing (else `context:: home` + Shift+Enter would store `home\`), and
 *     `stripPropertyLines` removes a marker left dangling on the new last
 *     line when the original last line is stripped.
 *
 * Everything here is pure and IPC-free; the flush integration owns the
 * actual `set_property` writes and the strip-only-on-success policy.
 */

import type { PropertyDefinition } from '@/lib/bindings'

/**
 * Keys the parser never treats as inline properties. Mirrors
 * `FRONTMATTER_RESERVED_KEYS` in `src-tauri/src/import.rs` (#1568): these are
 * exporter-managed / column-backed keys (`space` needs a `value_ref`, so a
 * text write would be rejected with a Validation error anyway).
 */
export const INLINE_PROPERTY_RESERVED_KEYS: ReadonlySet<string> = new Set([
  'space',
  'is_space',
  'created_at',
  'completed_at',
  'repeat',
  'repeat-until',
  'repeat-count',
  'repeat-seq',
  'repeat-origin',
  'template',
])

/**
 * Same key alphabet as `is_property_key` in import.rs and
 * `op::validate_set_property` in agaric-store: 1–64 chars of
 * `[A-Za-z0-9_-]`.
 */
export function isInlinePropertyKey(key: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(key)
}

/**
 * Length of the trailing `\` run on a serialized line. In serialized markdown
 * a literal backslash is escaped to `\\` (see `ALWAYS_ESCAPE` in
 * `markdown-serialize.ts`), so an ODD run means the final `\` is a hard-break
 * marker (`\` + newline), not value text.
 */
function trailingBackslashRun(line: string): number {
  let n = 0
  for (let i = line.length - 1; i >= 0 && line[i] === '\\'; i--) n++
  return n
}

/** Whether a serialized non-final line ends with a hard-break marker `\`. */
function endsWithHardBreakMarker(line: string): boolean {
  return trailingBackslashRun(line) % 2 === 1
}

export interface InlinePropertyLine {
  /** Trimmed, validated property key. */
  key: string
  /** Trimmed, non-empty value text (everything after the first `":: "`). */
  value: string
  /** 0-based index into `content.split('\n')` — used for selective stripping. */
  lineIndex: number
}

/**
 * Parse every property line out of a block's content. Returns one entry per
 * line that is EXACTLY a property line per the import.rs rules (see module
 * docstring). Lines that don't qualify — invalid key, empty value, reserved
 * key, inside a code fence — are simply not reported and therefore stay in
 * the content untouched.
 */
export function parseInlineProperties(content: string): InlinePropertyLine[] {
  const result: InlinePropertyLine[] = []
  let inFence = false
  const lines = content.split('\n')
  for (const [lineIndex, line] of lines.entries()) {
    // Drop the hard-break marker (`\` before the newline) from a non-final
    // line so it never leaks into the parsed value. The last line has no
    // following newline, so a trailing `\` there is literal text.
    const isLast = lineIndex === lines.length - 1
    const raw = !isLast && endsWithHardBreakMarker(line) ? line.slice(0, -1) : line
    const trimmed = raw.trim()
    // Fenced code guard — mirror import.rs's `line_is_code`: the delimiter
    // lines and everything between them are code, never properties.
    if (trimmed.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const sepIndex = trimmed.indexOf(':: ')
    if (sepIndex === -1) continue
    const key = trimmed.slice(0, sepIndex).trim()
    const value = trimmed.slice(sepIndex + 3).trim()
    if (!isInlinePropertyKey(key)) continue
    if (value === '') continue
    if (INLINE_PROPERTY_RESERVED_KEYS.has(key)) continue
    result.push({ key, value, lineIndex })
  }
  return result
}

/**
 * Remove the given (0-based) line indexes from `content`, joining the
 * remaining lines with `\n`. The flush integration calls this with ONLY the
 * lines whose property writes succeeded, so a rejected write leaves its line
 * literal (nothing lost).
 */
export function stripPropertyLines(content: string, lineIndexes: ReadonlySet<number>): string {
  if (lineIndexes.size === 0) return content
  const lines = content.split('\n')
  const kept = lines.filter((_, i) => !lineIndexes.has(i))
  // When the ORIGINAL last line is stripped, the line that becomes the new
  // last one may still carry its hard-break marker (`notes\` + newline +
  // `key:: value` → strip → `notes\`). A marker with no following line is a
  // dangling literal backslash after reparse — drop it.
  const last = kept.at(-1)
  if (last !== undefined && lineIndexes.has(lines.length - 1) && endsWithHardBreakMarker(last)) {
    kept[kept.length - 1] = last.slice(0, -1)
  }
  return kept.join('\n')
}

/** Param shape accepted by `setProperty` in `@/lib/tauri` (structural copy —
 *  kept local so this module stays free of value imports). */
export interface InlineSetPropertyParams {
  blockId: string
  key: string
  valueText?: string
  valueNum?: number
  valueDate?: string
  valueBool?: boolean
}

/**
 * Build the typed `setProperty` params for an inline value, honouring the
 * key's property DEFINITION the same way the drawer does
 * (`buildPropertyParams` in property-save-utils):
 *
 *   - no definition / `text` / `select` → `valueText` (the backend enforces
 *     select-option membership; a rejection leaves the line literal),
 *   - `number` → parsed via `Number`; an unparseable value returns `null`
 *     (treated as a rejected write — line stays literal) instead of writing
 *     `NaN` or silently coercing,
 *   - `date` → `valueDate`, but only for the app's `YYYY-MM-DD` storage
 *     shape (`getTodayString` / the drawer's date input). The backend only
 *     rejects EMPTY `value_date` (see `validate_set_property`), so passing
 *     free text through would store a garbage date that downstream agenda
 *     code parses as ISO 8601. Anything else returns `null` — line stays
 *     literal,
 *   - `boolean` → only the exact strings `true` / `false` are accepted;
 *     anything else returns `null`. DIVERGENCE from the drawer, which maps
 *     any non-'true' string to `false` — fine for a checkbox UI, silent data
 *     mangling for free-typed text,
 *   - `ref` → always `null`; a page reference cannot be expressed as inline
 *     text (the drawer uses a page picker for these).
 *
 * Returns `null` when the value cannot be represented for the key's type;
 * the caller must then leave the property line literal in the content.
 */
export function buildInlinePropertySetParams(
  blockId: string,
  key: string,
  value: string,
  def: PropertyDefinition | null,
): InlineSetPropertyParams | null {
  switch (def?.value_type) {
    case 'number': {
      const num = Number(value)
      return Number.isNaN(num) ? null : { blockId, key, valueNum: num }
    }
    case 'date': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
      return { blockId, key, valueDate: value }
    }
    case 'boolean': {
      if (value !== 'true' && value !== 'false') return null
      return { blockId, key, valueBool: value === 'true' }
    }
    case 'ref': {
      return null
    }
    default: {
      // No definition yet, or text/select — both store value_text.
      return { blockId, key, valueText: value }
    }
  }
}
