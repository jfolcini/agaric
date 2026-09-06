import type React from 'react'
import { useEffect, useRef, useState } from 'react'

/**
 * One-shot viewport gate (#758 item 5, #2670): returns `true` once the
 * referenced element has entered the viewport (+ `rootMargin` buffer), then
 * stays `true` — no flip-back, so a brief scroll away doesn't tear down what
 * the caller mounted. `enabled === false` starts entered (eager path).
 *
 * Callers gate expensive work on real visibility: `DaySection` mounts its
 * `BlockTree`, `AttachmentRenderer` reads the attachment bytes over IPC
 * (`loading="lazy"` on the `<img>` was decorative — the bytes were fetched in
 * the mount effect regardless of visibility, which hurt mobile memory on long
 * pages).
 */
export function useEnteredViewport<T extends HTMLElement>(
  enabled = true,
  rootMargin = '200px 0px',
): [boolean, React.RefObject<T | null>] {
  // A runtime without `IntersectionObserver` has no gate to wait for, so it
  // starts entered and loads eagerly.
  const [entered, setEntered] = useState(
    () => !enabled || typeof IntersectionObserver === 'undefined',
  )
  const ref = useRef<T | null>(null)

  useEffect(() => {
    if (!enabled || entered) return
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setEntered(true)
          observer.disconnect()
        }
      },
      { rootMargin },
    )
    observer.observe(el)
    return () => {
      observer.disconnect()
    }
  }, [enabled, entered, rootMargin])

  return [entered, ref]
}
