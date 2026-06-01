/**
 * Skin-tone (Fitzpatrick) support for the curated emoji set (#286).
 *
 * The curated `EMOJI` list (src/editor/emoji-data.ts) stores plain base
 * codepoints. A subset — hands / body / person emoji — accept one of the five
 * Fitzpatrick skin-tone modifiers (U+1F3FB–U+1F3FF). Appending a modifier to a
 * base that supports it yields the toned variant (e.g. 👍 + 🏽 → 👍🏽). Bases
 * that do NOT support modifiers (a yellow smiley, an object) must be left
 * untouched — appending a modifier there renders as the base followed by a
 * stray colour swatch.
 *
 * Rather than ship the full Unicode `emoji-zwj-sequences` table (out of scope
 * for the curated set), we enumerate the modifier-capable bases that actually
 * exist in our dataset. Keep this in sync when the curated gestures/body
 * section gains entries.
 */

/**
 * The five Fitzpatrick modifiers, light → dark, plus the "default" (none).
 * `labelKey` is the i18n key for the tone's accessible label (see the
 * `emojiPicker.skinTone.*` entries in `src/lib/i18n/editor.ts`).
 */
export const SKIN_TONES = [
  { id: 'default', labelKey: 'emojiPicker.skinTone.default', modifier: '' },
  { id: 'light', labelKey: 'emojiPicker.skinTone.light', modifier: '\u{1F3FB}' },
  { id: 'medium-light', labelKey: 'emojiPicker.skinTone.mediumLight', modifier: '\u{1F3FC}' },
  { id: 'medium', labelKey: 'emojiPicker.skinTone.medium', modifier: '\u{1F3FD}' },
  { id: 'medium-dark', labelKey: 'emojiPicker.skinTone.mediumDark', modifier: '\u{1F3FE}' },
  { id: 'dark', labelKey: 'emojiPicker.skinTone.dark', modifier: '\u{1F3FF}' },
] as const

export type SkinToneId = (typeof SKIN_TONES)[number]['id']

/**
 * Base emoji (as stored in `EMOJI`) that accept a Fitzpatrick modifier. These
 * are the hand / body / person glyphs present in our curated dataset. A
 * variation selector (`\u{FE0F}`) is stripped before applying the modifier
 * because the modifier itself supplies the emoji presentation.
 */
const TONABLE_BASES: ReadonlySet<string> = new Set([
  '\u{1F44D}', // thumbsup
  '\u{1F44E}', // thumbsdown
  '\u{1F44F}', // clap
  '\u{1F64F}', // pray
  '\u{1F44C}', // ok_hand
  '\u{1F4AA}', // muscle
  '\u{1F44B}', // wave
  '\u{1F91E}', // crossed_fingers
  '\u{270C}\u{FE0F}', // v
  '\u{1F590}\u{FE0F}', // raised_hand
  '\u{1F926}', // facepalm
  '\u{1F937}', // shrug
  '\u{1F64C}', // raised_hands
  '\u{1F447}', // point_down
  '\u{1F446}', // point_up
  '\u{1F449}', // point_right
  '\u{1F448}', // point_left
])

/** Whether `char` accepts a Fitzpatrick skin-tone modifier. */
export function supportsSkinTone(char: string): boolean {
  return TONABLE_BASES.has(char)
}

/**
 * Apply the given skin tone to `char`, returning the toned variant. Returns
 * `char` unchanged for the `default` tone or for bases that don't support
 * modifiers. Strips a trailing variation selector before appending the
 * modifier (the modifier supplies emoji presentation on its own).
 */
export function applySkinTone(char: string, tone: SkinToneId): string {
  if (tone === 'default') return char
  if (!supportsSkinTone(char)) return char
  const modifier = SKIN_TONES.find((t) => t.id === tone)?.modifier ?? ''
  if (modifier === '') return char
  const base = char.replace(/\u{FE0F}$/u, '')
  return base + modifier
}
