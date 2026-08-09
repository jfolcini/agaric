/**
 * Single-source chord parser for keyboard binding strings (#723).
 *
 * Before this module existed there were two divergent tokenizers: the
 * Settings-tab validator split on `/[+\-\s]+/` and accepted
 * Ctrl/Control/Cmd/Command/Meta/Alt/Option/Shift/Mod aliases, while the
 * matcher (`match.ts`) split ONLY on space-padded `' + '` and recognised
 * only lowercase `ctrl`/`shift`/`alt`/`meta`. Anything the validator
 * accepted but the matcher could not parse was silently saved as a dead
 * (or, for `Meta + K`, inverted) binding.
 *
 * Both sides now parse through {@link parseChord}:
 * - `storage.setCustomShortcut` normalises user input to the canonical
 *   `'Ctrl + Shift + E'` form via {@link normalizeBinding} before saving.
 * - `match.matchesShortcutBinding` parses bindings with {@link parseChord},
 *   so even legacy overrides saved in a non-canonical form (`Ctrl+E`,
 *   `Cmd + K`) are honoured.
 * - The Settings tab validates with {@link validateBindingInput}, which is
 *   definitionally "what the matcher can honour".
 */

import { isMatchableKeyToken } from '@/lib/keyboard-config/keys'

export interface ParsedChord {
  /** Requires Ctrl (or Cmd — the matcher treats `metaKey` as Ctrl). */
  ctrl: boolean
  alt: boolean
  shift: boolean
  /**
   * The non-modifier key token, verbatim apart from trimming (may contain
   * internal spaces, e.g. `Arrow Up`). Never empty and never a modifier.
   */
  key: string
}

/**
 * Modifier-name aliases → canonical modifier. `Cmd`/`Command`/`Meta`/`Mod`
 * map to `ctrl` because the matcher accepts `metaKey` wherever a binding
 * requires Ctrl (macOS parity) — there is no separate meta requirement.
 */
const MODIFIER_ALIASES: Readonly<Record<string, 'ctrl' | 'alt' | 'shift'>> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  cmd: 'ctrl',
  command: 'ctrl',
  meta: 'ctrl',
  mod: 'ctrl',
  '⌘': 'ctrl',
  '⌃': 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  '⌥': 'alt',
  shift: 'shift',
  '⇧': 'shift',
}

/**
 * A leading modifier name followed by a separator: `+`, `-`, or whitespace
 * (each optionally space-padded). The separator must FOLLOW a known
 * modifier name — the key itself may be `+` or `-` (`Ctrl + +`, `-`), so
 * separators are never consumed blindly.
 */
const MODIFIER_PREFIX = /^([A-Za-z]+)(\s*[+-]\s*|\s+)/

/**
 * A leading mac modifier GLYPH (`⌘⌥⌃⇧` — the exact set `formatChordTokens`
 * renders, so users copy them back into the Settings input). Unlike word
 * modifiers a glyph is unambiguous on its own, so the separator is optional
 * (`⌘K`, `⇧⌘K` are the conventional mac spellings).
 */
const GLYPH_PREFIX = /^([⌘⌥⌃⇧])\s*(?:[+-]\s*)?/

/**
 * Parse one chord (no ` / ` alternatives) into modifiers + key.
 * Accepts every alias/separator format the Settings input historically
 * accepted: `Ctrl+E`, `Ctrl-E`, `Ctrl + E`, `Ctrl Shift E`, `Cmd + K`,
 * `Mod + K`, `Option + Space`…
 *
 * Returns `null` for empty or modifier-only input (nothing the matcher
 * could ever fire on — `KeyboardEvent.key` is never empty).
 */
export function parseChord(input: string): ParsedChord | null {
  let rest = input.trim()
  const mods = { ctrl: false, alt: false, shift: false }
  for (;;) {
    const g = GLYPH_PREFIX.exec(rest)
    if (g) {
      // The glyph set is exactly four known modifiers — lookup cannot miss.
      mods[MODIFIER_ALIASES[g[1] as string] as 'ctrl' | 'alt' | 'shift'] = true
      rest = rest.slice(g[0].length)
      continue
    }
    const m = MODIFIER_PREFIX.exec(rest)
    if (!m) break
    const mod = MODIFIER_ALIASES[(m[1] as string).toLowerCase()]
    if (!mod) break
    mods[mod] = true
    rest = rest.slice(m[0].length)
  }
  const key = rest.trim()
  // A bare trailing modifier (`Ctrl + Shift`) is modifier-only, not a key.
  if (key === '' || MODIFIER_ALIASES[key.toLowerCase()] !== undefined) return null
  return { ...mods, key }
}

/**
 * Render a parsed chord in the canonical catalog form:
 * `Ctrl + Alt + Shift + Key`, single-letter keys uppercased.
 */
export function formatParsedChord(chord: ParsedChord): string {
  const parts: string[] = []
  if (chord.ctrl) parts.push('Ctrl')
  if (chord.alt) parts.push('Alt')
  if (chord.shift) parts.push('Shift')
  parts.push(chord.key.length === 1 ? chord.key.toUpperCase() : chord.key)
  return parts.join(' + ')
}

/**
 * Normalise a full binding string (including ` / ` separated alternatives)
 * to the canonical form the catalog uses. Alternatives that cannot be
 * parsed (modifier-only fragments — the UI rejects these before saving)
 * pass through trimmed-verbatim rather than being dropped.
 */
export function normalizeBinding(input: string): string {
  return input
    .trim()
    .split(' / ')
    .map((alt) => {
      const parsed = parseChord(alt)
      return parsed ? formatParsedChord(parsed) : alt.trim()
    })
    .join(' / ')
}

/** Why a typed binding cannot be saved, or `null` when it is honourable. */
export type BindingValidationError = 'empty' | 'modifierOnly' | 'unknownKey'

/**
 * Validate a user-typed binding the same way the matcher will read it
 * (semantics, now sharing the matcher's tokenizer). Each ` / `
 * alternative must parse to a chord with a real key, AND that key must be a
 * token the matcher can actually compare equal to a `KeyboardEvent.key`.
 *
 * #3308 — the key check is the `'unknownKey'` outcome. `parseChord` strips
 * known modifier prefixes and accepts ANY non-empty leftover as the key, so
 * `Ctrl + Shift + Esc` / `Cmd + Return` used to validate clean and save a
 * dead override (`match.normalizeKey` compares `esc` literally against
 * `escape`, which never matches). Because `getShortcutKeys` prefers the
 * override over the catalog default, the action lost its working shortcut
 * with no warning.
 */
export function validateBindingInput(input: string): BindingValidationError | null {
  const trimmed = input.trim()
  if (!trimmed) return 'empty'
  for (const alt of trimmed.split(' / ')) {
    const parsed = parseChord(alt)
    if (parsed === null) return 'modifierOnly'
    if (!isMatchableKeyToken(parsed.key)) return 'unknownKey'
  }
  return null
}
