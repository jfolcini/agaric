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
 * localStorage entries on first run. See REVIEW-LATER.md (MAINT-101) for the
 * design discussion. Do not reintroduce a "syncs via setProperty" claim in
 * this comment without also wiring the call — `tag-colors.test.ts` guards
 * against that drift.
 */

const STORAGE_KEY = 'tag-colors'

/** Preset color palette — 8 colors that work in both light and dark mode. */
export const TAG_COLOR_PRESETS = [
  { name: 'red', value: '#ef4444' },
  { name: 'orange', value: '#f97316' },
  { name: 'amber', value: '#f59e0b' },
  { name: 'green', value: '#22c55e' },
  { name: 'teal', value: '#14b8a6' },
  { name: 'blue', value: '#3b82f6' },
  { name: 'purple', value: '#a855f7' },
  { name: 'pink', value: '#ec4899' },
] as const

/** Read all tag colors from localStorage. */
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
    return result
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(colors))
}

/** Remove the color for a tag from localStorage. */
export function clearTagColor(tagId: string): void {
  const colors = getTagColors()
  delete colors[tagId]
  localStorage.setItem(STORAGE_KEY, JSON.stringify(colors))
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
