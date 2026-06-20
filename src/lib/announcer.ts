/**
 * Visually-hidden aria-live announcer for screen readers.
 * Singleton — creates a single DOM element on first use.
 */
let el: HTMLElement | null = null

/**
 * Coalescing window for identical announcements (ms). If `announce()` is called
 * with the same message within this window (e.g. rapid `Ctrl+Z` mashing),
 * subsequent calls are suppressed so screen-reader users hear t('announce.undone') once
 * per burst rather than once per keystroke. Distinct messages are NEVER
 * suppressed — different events still produce independent announcements.
 */
const COALESCE_WINDOW_MS = 500
let lastMessage: string | null = null
let lastAnnouncedAt = 0

/**
 * Pending distinct messages awaiting flush. A single polite live region with
 * `aria-atomic="true"` can only voice one value at a time, so two distinct
 * announcements made before the first paints would clobber each other (the
 * second overwrites the first in the shared node before the screen reader
 * voices it). We instead queue distinct messages and flush them one at a time,
 * giving each its own clear→set cycle so none is lost.
 */
const queue: string[] = []
let flushScheduled = false

/**
 * Delay (ms) between voicing one queued message and the next. Gives the screen
 * reader time to pick up the live-region change before we overwrite it.
 */
const FLUSH_GAP_MS = 150

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
  document.body.append(el)
  return el
}

/**
 * Schedule the message paint. Uses `requestAnimationFrame` normally, but falls
 * back to `setTimeout` when the document is hidden: rAF callbacks are throttled
 * (or paused entirely) for backgrounded tabs, which would strand the
 * announcement until the tab is refocused. The timeout fallback ensures the
 * live region still updates so the screen reader voices it.
 */
function schedulePaint(cb: () => void): void {
  if (typeof document !== 'undefined' && document.hidden) {
    setTimeout(cb, 0)
    return
  }
  requestAnimationFrame(cb)
}

/** Drain the queue one message at a time, voicing each distinctly. */
function flushQueue(): void {
  const message = queue.shift()
  if (message === undefined) {
    flushScheduled = false
    return
  }

  const node = getOrCreate()
  // Clear first, then set — forces screen reader to re-read even if same message
  node.textContent = ''
  schedulePaint(() => {
    node.textContent = message
    if (queue.length > 0) {
      // More distinct messages pending — voice the next after a short gap so the
      // screen reader registers this one before it's overwritten.
      setTimeout(flushQueue, FLUSH_GAP_MS)
    } else {
      flushScheduled = false
    }
  })
}

export function announce(message: string): void {
  // Suppress repeated identical messages within the coalescing window.
  const now = Date.now()
  if (message === lastMessage && now - lastAnnouncedAt < COALESCE_WINDOW_MS) {
    return
  }
  lastMessage = message
  lastAnnouncedAt = now

  // Ensure the live region exists synchronously (matches the element's
  // create-on-first-use contract regardless of when the queue drains).
  getOrCreate()

  queue.push(message)
  if (!flushScheduled) {
    flushScheduled = true
    flushQueue()
  }
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
  queue.length = 0
  flushScheduled = false
}
