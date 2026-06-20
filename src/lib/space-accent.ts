/**
 * Space accent-colour helper — shared by `SpaceAccentBadge` (collapsed
 * sidebar identity) and `SpaceSwitcher` (expanded sidebar trigger dot).
 *
 * Extracted from `SpaceAccentBadge` so the trigger-dot
 * fallback semantics live in one place. The token shape is
 * `accent-<name>` and matches the CSS variable names defined in
 * `index.css`; an unknown / null token resolves to
 * `var(--accent-current)` so a synced peer that introduced a new
 * palette token does not render a blank dot — visual fallback over
 * hard error.
 */

/**
 * Resolve a free-form `accent_color` token (e.g. `accent-emerald`) to a
 * CSS `var(...)` reference suitable for an inline `style.backgroundColor`
 * binding. Returns the brand-default `var(--accent-current)` for tokens
 * we don't recognise.
 */
export function accentVar(token: string | null | undefined): string {
  if (token == null || token === '') return 'var(--accent-current)'
  return `var(--${token}, var(--accent-current))`
}
