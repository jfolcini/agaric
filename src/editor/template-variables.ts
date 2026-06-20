/**
 * Dynamic template-variable substitution for `/template` insertion (#1442).
 *
 * Templates are deep-copied verbatim today; this module turns the copied
 * block text into a *dynamic* expansion pass that runs at insertion time.
 * It operates on the plain markdown string carried by each block at the
 * paste boundary (`BlockRow.content`), so it never has to understand the
 * rich-doc shape — marks and inline nodes are serialized as markdown around
 * the tokens and are left untouched.
 *
 * ## Token grammar
 *
 * A token is `{{ name }}` (surrounding whitespace inside the braces is
 * tolerated). Supported names:
 *
 *   - `{{date}}`          → today as `YYYY-MM-DD` (the project's ISO date)
 *   - `{{date:FORMAT}}`   → today via a `date-fns` format string. At minimum
 *                           `YYYY`, `MM`, `DD` are supported (mapped to the
 *                           `date-fns` `yyyy`/`MM`/`dd` tokens). Any other
 *                           `date-fns` pattern (e.g. `MMM d, yyyy`) also works
 *                           since the FORMAT is handed to `date-fns/format`.
 *   - `{{time}}`          → current time as `HH:mm` (24h)
 *   - `{{title}}`         → the target page's title (empty string if unknown)
 *   - `{{cursor}}`        → a *marker* (not literal text): records that the
 *                           caret should land in this block and is stripped
 *                           from the output. See `substituteTemplateVariables`.
 *
 * ## Unknown tokens
 *
 * Unknown tokens are left **verbatim** (e.g. `{{foo}}` stays `{{foo}}`). We
 * never drop them — a passthrough is the least surprising behaviour and keeps
 * authored braces (`{{ a JSON-ish snippet }}`) intact.
 *
 * ## Escaping
 *
 * A literal opening brace pair can be written as `\{{` — the backslash is
 * consumed and the `{{` is emitted verbatim without token expansion (so
 * `\{{date}}` renders the literal text `{{date}}`). This is the only escape;
 * everything else (including unknown tokens) passes through unchanged.
 */

import { format } from 'date-fns'

import { formatDate } from '@/lib/date-utils'

export interface TemplateVariableContext {
  /** Title of the page the template is being inserted into. */
  pageTitle?: string
  /**
   * Injectable "now" for deterministic tests. Defaults to `new Date()` at
   * call time so live insertion always reflects the real clock.
   */
  now?: Date
}

export interface SubstitutionResult {
  /** The expanded text with all tokens resolved and `{{cursor}}` stripped. */
  text: string
  /**
   * Whether this string contained a `{{cursor}}` marker. The caller uses
   * this to decide which inserted block should receive the caret after the
   * template lands. The marker itself is removed from `text`.
   */
  hasCursor: boolean
}

/**
 * Map the user-facing `{{date:FORMAT}}` tokens (`YYYY`/`MM`/`DD`) onto the
 * `date-fns` pattern tokens (`yyyy`/`MM`/`dd`). `date-fns` already uses `MM`
 * for the zero-padded month, so only year/day need translating. Other tokens
 * in the format string are passed straight through to `date-fns/format`.
 */
function toDateFnsPattern(userFormat: string): string {
  return userFormat.replace(/YYYY/g, 'yyyy').replace(/DD/g, 'dd')
}

/** Resolve a single token name (sans braces) to its value, or `null` if unknown. */
function resolveToken(rawName: string, now: Date, ctx: TemplateVariableContext): string | null {
  const name = rawName.trim()

  // `{{date:FORMAT}}` — split on the FIRST colon so the format may itself
  // contain colons (e.g. a time format).
  const colonIdx = name.indexOf(':')
  if (colonIdx !== -1) {
    const head = name.slice(0, colonIdx).trim().toLowerCase()
    const fmt = name.slice(colonIdx + 1).trim()
    if (head === 'date' && fmt.length > 0) {
      try {
        return format(now, toDateFnsPattern(fmt))
      } catch {
        // An invalid format string → leave the token verbatim rather than
        // throw mid-insertion. Returning null falls through to passthrough.
        return null
      }
    }
    return null
  }

  switch (name.toLowerCase()) {
    case 'date': {
      // Reuse the project's ISO date helper (YYYY-MM-DD).
      return formatDate(now)
    }
    case 'time': {
      return format(now, 'HH:mm')
    }
    case 'title': {
      return ctx.pageTitle ?? ''
    }
    default: {
      return null
    }
  }
}

/**
 * Expand `{{...}}` template variables in `text`.
 *
 * Pure and synchronous: no store/IPC access, fully unit-testable. The caller
 * supplies the page title and (optionally) a fixed `now`.
 *
 * `{{cursor}}` is treated as a marker: it is stripped from the output and the
 * returned `hasCursor` flag tells the caller this block is the caret target.
 * If a block contains multiple `{{cursor}}` markers, the first wins for caret
 * placement (all of them are stripped).
 */
export function substituteTemplateVariables(
  text: string,
  ctx: TemplateVariableContext = {},
): SubstitutionResult {
  const now = ctx.now ?? new Date()
  let hasCursor = false

  // Single pass over the string. Each match is either an escaped `\{{`
  // (emit a literal `{{`) or a `{{ name }}` token. The `name` is lazy
  // (`[^]*?`) up to the first `}}`, so adjacent tokens don't merge.
  const out = text.replace(/\\\{\{|\{\{([^]*?)\}\}/g, (whole, name?: string) => {
    // Escaped opener: `\{{` → literal `{{` (the rest of the original text,
    // including a following name and `}}`, is left untouched because the
    // regex only consumed the two braces here).
    if (name === undefined) return '{{'

    const trimmed = name.trim()
    if (trimmed.toLowerCase() === 'cursor') {
      hasCursor = true
      return ''
    }

    const resolved = resolveToken(name, now, ctx)
    // Unknown token → passthrough verbatim (don't drop it).
    return resolved === null ? whole : resolved
  })

  return { text: out, hasCursor }
}
