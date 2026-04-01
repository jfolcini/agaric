/**
 * Visually-hidden aria-live announcer for screen readers.
 * Singleton — creates a single DOM element on first use.
 */
let el: HTMLElement | null = null

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
  const node = getOrCreate()
  // Clear first, then set — forces screen reader to re-read even if same message
  node.textContent = ''
  requestAnimationFrame(() => {
    node.textContent = message
  })
}
