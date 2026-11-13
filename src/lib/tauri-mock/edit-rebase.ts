/**
 * Mirror of `agaric_engine::edit_rebase`: an editor that started from
 * `baseText` has its change replayed on the text the block holds now, unless
 * the two changes share text. Counted in code points, as Rust counts chars.
 */

/** The one splice turning `old` into `next`: `[start, end)` of `old`, and its replacement. */
function splice(old: string[], next: string[]): [number, number, string[]] {
  let prefix = 0
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++
  let suffix = 0
  while (
    suffix < old.length - prefix &&
    suffix < next.length - prefix &&
    old[old.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix++
  }
  return [prefix, old.length - suffix, next.slice(prefix, next.length - suffix)]
}

/** `rebase_edit`: `null` when the two changes overlap. */
export function rebaseEdit(baseText: string, toText: string, currentText: string): string | null {
  const base = Array.from(baseText)
  const current = Array.from(currentText)
  const [start, end, typed] = splice(base, Array.from(toText))
  const [theirStart, theirEnd, theirs] = splice(base, current)
  let shift: number
  if (theirEnd <= start) shift = theirStart + theirs.length - theirEnd
  else if (end <= theirStart) shift = 0
  else return null
  return [...current.slice(0, start + shift), ...typed, ...current.slice(end + shift)].join('')
}

/** `rebased_onto` in `commands/blocks/crud.rs`. */
export function rebasedOnto(
  current: string,
  baseText: string | null | undefined,
  toText: string,
): string {
  if (baseText == null || baseText === current) return toText
  return rebaseEdit(baseText, toText, current) ?? toText
}
