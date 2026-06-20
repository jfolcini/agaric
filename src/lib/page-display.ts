/**
 * Page-display — single source of truth for hierarchical page-name display (Bug 1).
 *
 * Page titles in this codebase are stored verbatim as `parent/child/leaf`
 * strings. Different surfaces render them differently — the tree shows
 * only the leaf, the picker shows leaf-with-breadcrumb, the page header
 * shows segmented crumbs. Before this module, each surface inlined its
 * own `title.split('/')` logic, which drifted as new surfaces appeared.
 *
 * `getPageDisplayName(fullPath, mode)` is the one place that knows how
 * to split a namespaced title. Every surface that needs to render a
 * page title hands its raw `fullPath` to this function and consumes the
 * returned `{ label, breadcrumb?, title }` triple:
 *
 * - `label`: the primary text to render.
 * - `breadcrumb`: optional secondary text (only set in `'leaf-with-breadcrumb'`
 *   mode for namespaced titles).
 * - `title`: ALWAYS the full path. Use it for the HTML `title=""` tooltip
 *   so the full path stays discoverable when the visible text is
 *   truncated to the leaf.
 *
 * Per-mode behaviour:
 *
 * | Mode                    | Namespaced (`a/b/c`)                                | Non-namespaced (`foo`) |
 * | ----------------------- | --------------------------------------------------- | ---------------------- |
 * | `full`                  | `{ label: 'a/b/c',      title: 'a/b/c'  }`         | `{ label: 'foo', title: 'foo' }` |
 * | `leaf`                  | `{ label: 'c',          title: 'a/b/c'  }`         | `{ label: 'foo', title: 'foo' }` |
 * | `leaf-with-breadcrumb`  | `{ label: 'c', breadcrumb: 'a / b', title: 'a/b/c' }` | `{ label: 'foo', title: 'foo' }` |
 *
 * For non-namespaced titles the three modes collapse to the same shape —
 * there is nothing to split, and no `breadcrumb` is set.
 *
 * Edge cases (covered by `__tests__/page-display.test.ts`):
 * - Empty string → `{ label: '', title: '' }` (no slash, treated as non-namespaced).
 * - Leading slash (`/foo`) → leaf is `foo`, breadcrumb is the empty prefix.
 *   The function does not silently normalise leading/trailing/double slashes
 *   — those are surface-level inputs the caller controls.
 */

export type PageDisplayMode = 'full' | 'leaf' | 'leaf-with-breadcrumb'

export interface PageDisplay {
  label: string
  breadcrumb?: string
  title: string
}

/**
 * Returns the per-mode display triple for a page title. See module docstring.
 *
 * `title` is always the full path so callers can wire the HTML `title=""`
 * attribute without re-deriving it.
 */
export function getPageDisplayName(fullPath: string, mode: PageDisplayMode): PageDisplay {
  // Non-namespaced titles collapse to the same shape across all three
  // modes — no slash to split on, no breadcrumb to surface.
  if (!fullPath.includes('/')) {
    return { label: fullPath, title: fullPath }
  }

  if (mode === 'full') {
    return { label: fullPath, title: fullPath }
  }

  // Both `'leaf'` and `'leaf-with-breadcrumb'` need the split — share it.
  const parts = fullPath.split('/')
  // `parts.pop()` is safe (length >= 2 because the string contains `/`).
  // The fallback `''` keeps TS happy and mirrors what `pop()` would
  // return for the pathological `'/'`-only input.
  const leaf = parts.pop() ?? ''

  if (mode === 'leaf') {
    return { label: leaf, title: fullPath }
  }

  // mode === 'leaf-with-breadcrumb'
  return { label: leaf, breadcrumb: parts.join(' / '), title: fullPath }
}
