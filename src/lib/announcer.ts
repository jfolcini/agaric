/**
 * Visually-hidden aria-live announcer for screen readers.
 * Singleton — creates a single DOM element on first use.
 */
let el: HTMLElement | null = null

/**
 * Coalescing window for identical announcements (ms). If `announce()` is called
 * with the same message within this window (e.g. rapid `Ctrl+Z` mashing),
 * subsequent calls are suppressed so screen-reader users hear "Undone" once
 * per burst rather than once per keystroke. Distinct messages are NEVER
 * suppressed — different events still produce independent announcements.
 */
const COALESCE_WINDOW_MS = 500
let lastMessage: string | null = null
let lastAnnouncedAt = 0

function getOrCreate(): HTMLElement {
  if (el && document.body.contains(el)) return el
  el = document.createElement('div')
  el.setAttribute('aria-live', 'polite')
  el.setAttribute('aria-atomic', 'true')
  el.setAttribute('role', 'status')
  // Visually hidden but accessible
  Object.assign(el.style, {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: '0',
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap',
    border: '0',
  })
  el.id = 'sr-announcer'
  document.body.appendChild(el)
  return el
}

export function announce(message: string): void {
  // Suppress repeated identical messages within the coalescing window.
  const now = Date.now()
  if (message === lastMessage && now - lastAnnouncedAt < COALESCE_WINDOW_MS) {
    return
  }
  lastMessage = message
  lastAnnouncedAt = now

  const node = getOrCreate()
  // Clear first, then set — forces screen reader to re-read even if same message
  node.textContent = ''
  requestAnimationFrame(() => {
    node.textContent = message
  })
}

/**
 * Reset the announcer's coalescing state. Test-only — clears the singleton
 * DOM node and the last-announced cache so tests are isolated from each other.
 */
export function __resetAnnouncerForTests(): void {
  if (el?.parentNode) el.parentNode.removeChild(el)
  el = null
  lastMessage = null
  lastAnnouncedAt = 0
}
