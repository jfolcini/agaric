/**
 * Tag colors — localStorage-backed map of tag ID → CSS color string.
 *
 * Stores a JSON object under the `tag-colors` localStorage key for fast
 * rendering. **Storage is device-local only** — no IPC, no `setProperty()`
 * call, no block-property write. Multi-device users will see different colors
 * for the same tag on different devices, and a fresh install starts with an
 * empty palette.
 *
 * Pattern follows starred-pages.ts (also device-local).
 *
 * Future work (out of scope here): cross-device sync could be added by
 * mirroring the chosen color to a `tag_color` block property via the existing
 * properties extension point, with a one-time migration of existing
 * localStorage entries on first run. Do not reintroduce a "syncs via setProperty" claim in
 * this comment without also wiring the call — `tag-colors.test.ts` guards
 * against that drift.
 */

import { accentVar } from './space-accent'

const STORAGE_KEY = 'tag-colors'

/**
 * Preset color palette — re-keyed (#1099) onto the themed per-space
 * `--accent-*` token palette (`index.css`) instead of a parallel set of
 * flat sRGB hex values.
 *
 * Each preset's `value` is now an *accent token* (e.g. `'accent-rose'`),
 * resolved at render time through `accentVar()` → `var(--accent-rose, …)`.
 * Because the underlying tokens are defined in OKLCH with distinct light,
 * dark and `prefers-contrast: more` values, tag pills now auto-retheme and
 * participate in high-contrast mode — exactly like the SpaceAccentBadge /
 * status-bar chip that already consume these tokens.
 *
 * Foreground strategy (issue #1099 caveat): there are NO
 * `--accent-*-foreground` paired tokens, and `pickReadableForeground`
 * cannot read a computed `var()` hue from JS at runtime. We therefore pin a
 * fixed, legible foreground per accent (`fg`), chosen against the token's
 * OKLCH lightness across themes. Free-form custom hex values still flow
 * through `pickReadableForeground` (see `tagColorForeground`).
 *
 * `value` is the persisted token; this is what lands in localStorage for new
 * selections. Legacy hex values are migrated to their nearest token by
 * `migrateTagColors` (see `LEGACY_HEX_TO_TOKEN`).
 */
export const TAG_COLOR_PRESETS = [
  { name: 'emerald', value: 'accent-emerald', fg: '#000' },
  { name: 'blue', value: 'accent-blue', fg: '#fff' },
  { name: 'violet', value: 'accent-violet', fg: '#fff' },
  { name: 'amber', value: 'accent-amber', fg: '#000' },
  { name: 'rose', value: 'accent-rose', fg: '#fff' },
  { name: 'slate', value: 'accent-slate', fg: '#fff' },
  { name: 'orange', value: 'accent-orange', fg: '#000' },
] as const

/** Set of recognised accent tokens, for `isAccentToken` guards. */
const ACCENT_TOKENS: ReadonlySet<string> = new Set(TAG_COLOR_PRESETS.map((p) => p.value))

/** Fixed legible foreground per accent token (see `TAG_COLOR_PRESETS`). */
const ACCENT_FOREGROUND: Record<string, '#000' | '#fff'> = Object.fromEntries(
  TAG_COLOR_PRESETS.map((p) => [p.value, p.fg]),
)

/**
 * One-time migration map (#1099): the 8 legacy flat-sRGB presets that used
 * to be persisted, mapped to their nearest themed accent token by hue.
 * Applied lazily on read by `migrateTagColors` so existing tags re-theme
 * without a destructive recolor — the hue is preserved, only the fidelity
 * (flat sRGB → OKLCH, theme-aware) changes.
 */
export const LEGACY_HEX_TO_TOKEN: Readonly<Record<string, string>> = {
  '#ef4444': 'accent-rose', // red   → rose (hue ~12)
  '#f97316': 'accent-orange', // orange
  '#f59e0b': 'accent-amber', // amber
  '#22c55e': 'accent-emerald', // green → emerald
  '#14b8a6': 'accent-emerald', // teal  → emerald (no dedicated teal token)
  '#3b82f6': 'accent-blue', // blue
  '#a855f7': 'accent-violet', // purple → violet
  '#ec4899': 'accent-rose', // pink  → rose (no dedicated pink token)
}

/** True when `value` is one of the recognised `accent-*` palette tokens. */
export function isAccentToken(value: string): boolean {
  return ACCENT_TOKENS.has(value)
}

/**
 * One-time migration (#1099): rewrite any legacy flat-sRGB preset values to
 * their nearest themed accent token. Pure — takes the raw stored map and
 * returns `{ colors, changed }` where `changed` flags whether at least one
 * value was rewritten (so callers can decide whether to persist back).
 *
 * Only the 8 known legacy preset hexes are migrated; free-form custom hex
 * values (the power-user escape hatch) and already-token values are left
 * untouched, so a user's deliberate custom color is never recolored.
 */
export function migrateTagColors(colors: Record<string, string>): {
  colors: Record<string, string>
  changed: boolean
} {
  let changed = false
  const next: Record<string, string> = {}
  for (const [k, v] of Object.entries(colors)) {
    const mapped = LEGACY_HEX_TO_TOKEN[v.toLowerCase()]
    if (mapped !== undefined) {
      next[k] = mapped
      changed = true
    } else {
      next[k] = v
    }
  }
  return { colors: next, changed }
}

/**
 * Read all tag colors from localStorage, applying the #1099 legacy-hex →
 * accent-token migration. If the migration rewrote anything, the migrated
 * shape is persisted back once so subsequent reads are stable.
 */
export function getTagColors(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const result: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') result[k] = v
    }
    const { colors, changed } = migrateTagColors(result)
    if (changed) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(colors))
      } catch {
        // Storage unavailable — return the migrated map in-memory anyway so
        // rendering re-themes this session; persistence retries next read.
      }
    }
    return colors
  } catch {
    return {}
  }
}

/** Get the color for a specific tag. Returns undefined if not set. */
export function getTagColor(tagId: string): string | undefined {
  return getTagColors()[tagId]
}

/** Set the color for a tag in localStorage. */
export function setTagColor(tagId: string, color: string): void {
  const colors = getTagColors()
  colors[tagId] = color
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(colors))
  } catch {
    // Storage unavailable (private mode / quota / locked-down webview) —
    // degrade to no-persist rather than throwing into the click handler.
    // Mirrors the silent fallback in getTagColors above.
  }
}

/** Remove the color for a tag from localStorage. */
export function clearTagColor(tagId: string): void {
  const colors = getTagColors()
  delete colors[tagId]
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(colors))
  } catch {
    // Storage unavailable — degrade to no-persist (see setTagColor).
  }
}

/**
 * Resolve a stored tag color value to a CSS `background-color` string for an
 * inline style (#1099).
 *
 * - An accent token (e.g. `'accent-rose'`) → `var(--accent-rose, …)` via
 *   `accentVar`, so the pill auto-rethemes (light/dark/high-contrast).
 * - A free-form custom hex (power-user escape hatch) → the hex verbatim.
 */
export function resolveTagBackground(value: string): string {
  return isAccentToken(value) ? accentVar(value) : value
}

/**
 * Resolve the legible foreground color for a stored tag color value (#1099).
 *
 * - Accent token → its fixed paired foreground (`ACCENT_FOREGROUND`),
 *   chosen at design time against the token's OKLCH lightness. JS cannot
 *   read a computed `var()` hue at runtime, so this avoids guessing.
 * - Custom hex → `pickReadableForeground` (WCAG luminance), unchanged.
 */
export function tagColorForeground(value: string): '#000' | '#fff' {
  return ACCENT_FOREGROUND[value] ?? pickReadableForeground(value)
}

/**
 * Pick a readable foreground (`'#000'` or `'#fff'`) for text rendered on
 * top of an arbitrary hex background, using the WCAG 2.x relative-luminance
 * formula. Returns whichever channel yields the higher contrast ratio
 * against the background — equivalent to picking the side of the
 * luminance midpoint (~0.179) that the background falls on.
 *
 * Note: because WCAG contrast is asymmetric (contrast vs black grows
 * linearly while contrast vs white grows hyperbolically), most saturated
 * mid-tone colors (e.g. Tailwind `*-500`) get HIGHER contrast against
 * BLACK than against white, even though convention often pairs them with
 * white text. This helper follows the math, not the convention — that is
 * the whole point of replacing the hard-coded `'#fff'`.
 *
 * Accepts `#rgb`, `#rrggbb`, and `#rrggbbaa` hex strings (alpha ignored).
 * For any input that cannot be parsed (empty, malformed, non-hex), falls
 * back to `'#000'` so badges never render invisible white-on-white text.
 *
 * Used by TagList to replace the previously hard-coded `color: '#fff'`
 * inline style, which failed WCAG contrast on light pastel tag fills.
 */
export function pickReadableForeground(hex: string): '#000' | '#fff' {
  const rgb = parseHexToRgb(hex)
  if (rgb === null) return '#000'

  // WCAG relative luminance: per-channel sRGB linearization, then
  // weighted sum. https://www.w3.org/TR/WCAG20/#relativeluminancedef
  const toLinear = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const r = toLinear(rgb.r)
  const g = toLinear(rgb.g)
  const b = toLinear(rgb.b)
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b

  // Contrast vs white = 1.05 / (L + 0.05); vs black = (L + 0.05) / 0.05.
  // Pick whichever channel clears 4.5:1 first; when both clear (rare in the
  // mid-luminance band) prefer black, which is generally more legible on
  // saturated mid-tones than white. Equivalent to comparing against the
  // luminance midpoint sqrt(1.05 * 0.05) - 0.05 ≈ 0.1791.
  const contrastWithBlack = (luminance + 0.05) / 0.05
  const contrastWithWhite = 1.05 / (luminance + 0.05)
  return contrastWithBlack >= contrastWithWhite ? '#000' : '#fff'
}

/**
 * Parse a hex color string into 0-255 RGB channels. Returns `null` for
 * any input that isn't a valid 3-, 6-, or 8-digit hex color.
 */
function parseHexToRgb(hex: string): { r: number; g: number; b: number } | null {
  if (typeof hex !== 'string') return null
  const trimmed = hex.trim()
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(trimmed)
  if (match === null) return null
  let body = match[1]
  if (body === undefined) return null
  if (body.length === 3) {
    body = body
      .split('')
      .map((c) => c + c)
      .join('')
  }
  const r = Number.parseInt(body.slice(0, 2), 16)
  const g = Number.parseInt(body.slice(2, 4), 16)
  const b = Number.parseInt(body.slice(4, 6), 16)
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null
  return { r, g, b }
}
