/**
 * The colours a highlight can carry (#6759), in Obsidian's form: a colour
 * emoji right after the opening `==` (`==🔴text==`, Obsidian help, *Basic
 * formatting syntax*). With no emoji a highlight takes the theme's default
 * colour. Each colour draws from its `--highlight-<id>` token pair.
 */

export const HIGHLIGHT_COLORS = [
  { id: 'red', emoji: '🔴' },
  { id: 'orange', emoji: '🟠' },
  { id: 'yellow', emoji: '🟡' },
  { id: 'green', emoji: '🟢' },
  { id: 'blue', emoji: '🔵' },
  { id: 'purple', emoji: '🟣' },
] as const

export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number]['id']

/** The colour whose emoji opens `s` at `pos`, with the emoji's UTF-16 length; null if none does. */
export function highlightColorAt(
  s: string,
  pos: number,
): { color: HighlightColor; length: number } | null {
  for (const { id, emoji } of HIGHLIGHT_COLORS) {
    if (s.startsWith(emoji, pos)) return { color: id, length: emoji.length }
  }
  return null
}

/** The emoji a highlight of `color` is written with. */
export function highlightColorEmoji(color: HighlightColor): string {
  return HIGHLIGHT_COLORS.find((c) => c.id === color)?.emoji ?? ''
}

/** `value` if it names a highlight colour, else null: a mark attribute read from the DOM or a doc. */
export function asHighlightColor(value: unknown): HighlightColor | null {
  return HIGHLIGHT_COLORS.some((c) => c.id === value) ? (value as HighlightColor) : null
}
