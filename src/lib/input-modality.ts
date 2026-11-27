/**
 * Writes `<html data-pointer>` while the last input was a pointer press, and
 * removes it on the next key press, so CSS can ring a script-focused element
 * only when the keyboard moved it there (the block-select cursor's ring,
 * `SortableBlock`). `:focus-visible` cannot: Chromium does not count a Ctrl
 * chord as keyboard use, so Ctrl+Arrow after a click would move an unringed
 * cursor. A bare modifier press does not count: Ctrl+Click presses Ctrl first.
 * Call once, before the first render.
 */
export function syncPointerAttribute(): void {
  const root = document.documentElement
  document.addEventListener('pointerdown', () => root.setAttribute('data-pointer', ''), true)
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return
      root.removeAttribute('data-pointer')
    },
    true,
  )
}
