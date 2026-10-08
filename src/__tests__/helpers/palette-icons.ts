/**
 * The icons that the svg-scoped `text-icon` variant class on `el` paints (#5368).
 *
 * Tailwind does not run under happy-dom, so this turns the arbitrary variant
 * back into the selector Tailwind would emit and lets the DOM's own selector
 * engine pick the icons, including the `:not([class*='text-'])` escape.
 */
export function paletteIconsOf(el: Element): Element[] {
  const rule = [...el.classList].find((c) => c.endsWith(']:text-icon'))
  if (rule === undefined) return []
  const selector = rule.slice(1, -']:text-icon'.length).replaceAll('_', ' ').replace('&', ':scope')
  return [...el.querySelectorAll(selector)]
}
