/**
 * Split a catalog keys string ("Ctrl + Shift + F") into a list of chord
 * chip tokens with platform-typical glyphs.
 *
 * The catalog stores chord names as "Modifier + Modifier + Key"
 * (`src/lib/keyboard-config/catalog.ts`). We map a small allow-list of
 * common modifier names to single-glyph chips so they read as keyboard
 * shortcuts at a glance (Raycast / Linear / VSCode parity). Unknown tokens
 * fall through verbatim (uppercased) so a future catalog addition does not
 * silently render blank.
 *
 * Shared by the command palette and the slash-command suggestion list so
 * Both surfaces render the same chip tokens (#211 P0-5).
 */

const GLYPHS: Record<string, string> = {
  ctrl: '⌃',
  control: '⌃',
  shift: '⇧',
  cmd: '⌘',
  command: '⌘',
  meta: '⌘',
  alt: '⌥',
  option: '⌥',
  enter: '↵',
  return: '↵',
  escape: 'esc',
  esc: 'esc',
  space: '␣',
  tab: '⇥',
  backspace: '⌫',
}

export function formatChordTokens(keys: string): string[] {
  if (keys.length === 0) return []
  return keys
    .split('+')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => GLYPHS[t.toLowerCase()] ?? t.toUpperCase())
}
