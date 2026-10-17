/**
 * Tag colors — localStorage-backed map of tag ID → accent token or custom hex.
 *
 * Stores a JSON object under the `tag-colors` localStorage key, which every tag
 * chip and badge renders from. `useTagColors` also writes the tag's `color`
 * property best-effort, but nothing reads it back, so a colour stays on the
 * device that set it.
 *
 * Pattern follows starred-pages.ts (also device-local).
 */

import { PREFERENCES, readPreference, writePreference } from '@/lib/preferences'
import { accentVar } from '@/lib/space-accent'

/**
 * Preset color palette (#1099): each `value` is a themed `--accent-*` token
 * (`index.css`), resolved at render time through `accentVar()`, so tag colours
 * re-theme across light, dark and `prefers-contrast: more` like the
 * SpaceAccentBadge does. `value` is what lands in localStorage; legacy hex
 * values are migrated to their nearest token by `migrateTagColors`.
 */
export const TAG_COLOR_PRESETS = [
  { name: 'emerald', value: 'accent-emerald' },
  { name: 'blue', value: 'accent-blue' },
  { name: 'violet', value: 'accent-violet' },
  { name: 'amber', value: 'accent-amber' },
  { name: 'rose', value: 'accent-rose' },
  { name: 'slate', value: 'accent-slate' },
  { name: 'orange', value: 'accent-orange' },
] as const

/** Set of recognised accent tokens, for `isAccentToken` guards. */
const ACCENT_TOKENS: ReadonlySet<string> = new Set(TAG_COLOR_PRESETS.map((p) => p.value))

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
  const result = readPreference(PREFERENCES.tagColors)
  const { colors, changed } = migrateTagColors(result)
  if (changed) {
    // Storage-unavailable write failures are logged and swallowed by
    // writePreference — the migrated map above is returned in-memory anyway
    // so rendering re-themes this session; persistence retries next read.
    writePreference(PREFERENCES.tagColors, colors)
  }
  return colors
}

/** Get the color for a specific tag. Returns undefined if not set. */
export function getTagColor(tagId: string): string | undefined {
  return getTagColors()[tagId]
}

/**
 * Set the color for a tag in localStorage. Storage-unavailable write
 * failures (private mode / quota / locked-down webview) are logged and
 * swallowed by `writePreference` rather than thrown into the click handler.
 */
export function setTagColor(tagId: string, color: string): void {
  const colors = getTagColors()
  colors[tagId] = color
  writePreference(PREFERENCES.tagColors, colors)
}

/** Remove the color for a tag from localStorage (see `setTagColor`). */
export function clearTagColor(tagId: string): void {
  const colors = getTagColors()
  delete colors[tagId]
  writePreference(PREFERENCES.tagColors, colors)
}

/**
 * Resolve a stored tag color value to a CSS colour (#1099).
 *
 * - An accent token (e.g. `'accent-rose'`) → `var(--accent-rose, …)` via
 *   `accentVar`, so the pill auto-rethemes (light/dark/high-contrast).
 * - A free-form custom hex (power-user escape hatch) → the hex verbatim.
 */
export function resolveTagBackground(value: string): string {
  return isAccentToken(value) ? accentVar(value) : value
}

/** Inline style of a coloured tag chip or badge (see `tagColorStyle`). */
interface TagColorStyle {
  '--tag-color': string
  color: string
  backgroundColor: string
}

/**
 * The inline style that paints a tag chip or badge in the tag's colour, or
 * `undefined` for an uncoloured tag, which keeps its default look. The text is
 * the colour pulled halfway to the theme's ink, on a light tint of the colour:
 * the bare colour as text on a light page, or white on the colour, is too faint
 * to read for most presets.
 */
export function tagColorStyle(value: string | undefined): TagColorStyle | undefined {
  if (!value) return undefined
  return {
    '--tag-color': resolveTagBackground(value),
    color: 'color-mix(in oklab, var(--tag-color) 50%, var(--foreground))',
    backgroundColor: 'color-mix(in oklab, var(--tag-color) 15%, transparent)',
  }
}
