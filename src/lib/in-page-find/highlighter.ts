/**
 * Highlighter — paints {@link FindMatch} ranges onto the page via the
 * CSS Custom Highlight Registry (`CSS.highlights`). Non-destructive:
 * no DOM mutation, no React tree changes, no `dangerouslySetInnerHTML`.
 *
 * The registry exposes two named highlights:
 *
 *  - `find-match` — every match.
 *  - `find-match-current` — the single match at the current index;
 *    drawn with a stronger accent so the user can spot the cursor.
 *
 * Styling lives in `src/index.css` under the `::highlight(find-match)` /
 * `::highlight(find-match-current)` selectors.
 *
 * ## Graceful degradation
 *
 * Older WebViews and the `happy-dom` test environment don't expose
 * `CSS.highlights`. Every function in this module guards on
 * {@link isSupported} and no-ops cleanly when the API is missing —
 * the matcher still produces counts, only the visual highlight is
 * skipped. Scroll-into-view falls back to scrolling the `node.parentElement`.
 */

import type { FindMatch } from './matcher'

const HIGHLIGHT_ALL = 'find-match'
const HIGHLIGHT_CURRENT = 'find-match-current'

interface HighlightLike {
  add(range: Range): unknown
  clear(): void
  size: number
}

interface CSSHighlights {
  set(name: string, highlight: HighlightLike): unknown
  delete(name: string): boolean
  has(name: string): boolean
  get(name: string): HighlightLike | undefined
}

interface CSSWithHighlights {
  highlights?: CSSHighlights
}

interface HighlightCtor {
  new (...ranges: Range[]): HighlightLike
}

function getRegistry(): CSSHighlights | null {
  const css = (globalThis as { CSS?: CSSWithHighlights }).CSS
  return css?.highlights ?? null
}

function getHighlightCtor(): HighlightCtor | null {
  const ctor = (globalThis as { Highlight?: HighlightCtor }).Highlight
  return ctor ?? null
}

/** Returns true when the CSS Custom Highlight API is usable in this environment. */
export function isSupported(): boolean {
  return getRegistry() !== null && getHighlightCtor() !== null
}

/**
 * Build a `Range` for a {@link FindMatch}. Returns `null` when the
 * underlying text node has been detached / orphaned mid-walk (rare —
 * happens when React re-renders the page between match collection and
 * range construction).
 */
function rangeFor(match: FindMatch): Range | null {
  const doc = match.node.ownerDocument
  if (!doc) return null
  try {
    const range = doc.createRange()
    range.setStart(match.node, match.start)
    range.setEnd(match.node, match.end)
    return range
  } catch {
    // Offsets exceeded nodeValue.length (node was edited between
    // match collection and paint). Skip silently — the next walk
    // will refresh.
    return null
  }
}

/**
 * Replace the current highlight set with the given matches and current index.
 *
 * Idempotent: calling `paint([], -1)` (or `clear()`) leaves the page in a
 * clean state. The function is safe to call from React effects during
 * cleanup.
 */
export function paint(matches: FindMatch[], currentIndex: number): void {
  const registry = getRegistry()
  const Ctor = getHighlightCtor()
  if (!registry || !Ctor) return

  // Always rebuild from scratch — `Highlight.clear()` then `add()` per
  // range is the documented pattern, and the cost is O(N) DOM-free.
  const all = new Ctor()
  let current: HighlightLike | null = null
  if (currentIndex >= 0 && currentIndex < matches.length) {
    current = new Ctor()
  }

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]
    if (!match) continue
    const range = rangeFor(match)
    if (!range) continue
    if (i === currentIndex && current) {
      current.add(range)
    } else {
      all.add(range)
    }
  }

  registry.set(HIGHLIGHT_ALL, all)
  if (current) {
    registry.set(HIGHLIGHT_CURRENT, current)
  } else {
    registry.delete(HIGHLIGHT_CURRENT)
  }
}

/** Clear all in-page-find highlights. Safe to call when unsupported. */
export function clear(): void {
  const registry = getRegistry()
  if (!registry) return
  registry.delete(HIGHLIGHT_ALL)
  registry.delete(HIGHLIGHT_CURRENT)
}

/**
 * Scroll the given match into view so the user can see the current
 * highlight. Uses the match's parent element's `scrollIntoView` —
 * Range itself has no scrollIntoView method.
 *
 * `behavior: 'smooth'` is suppressed when the user prefers reduced
 * motion (the `(prefers-reduced-motion: reduce)` media query). The
 * `block: 'center'` keeps the match away from sticky overlays
 * (the in-page-find toolbar lives at the top of the viewport, so
 * `block: 'start'` would scroll the match _under_ the toolbar).
 */
export function scrollIntoViewMatch(match: FindMatch): void {
  const parent = match.node.parentElement
  if (!parent) return
  const reduceMotion =
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
  parent.scrollIntoView({
    behavior: reduceMotion ? 'auto' : 'smooth',
    block: 'center',
    inline: 'nearest',
  })
}
