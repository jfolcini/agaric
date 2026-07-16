/**
 * Skin-tone (Fitzpatrick) support for the emoji set (#286).
 *
 * A subset of emoji — hands / body / person glyphs — accept one of the five
 * Fitzpatrick skin-tone modifiers (U+1F3FB–U+1F3FF). Appending a modifier to a
 * base that supports it yields the toned variant (e.g. 👍 + 🏽 → 👍🏽). Bases
 * that do NOT support modifiers (a yellow smiley, an object) must be left
 * untouched — appending a modifier there renders as the base followed by a
 * stray colour swatch.
 *
 * The set of tonable bases is derived from the generated dataset's `skin`
 * flag (`src/editor/emoji-data.ts`), which the build-time generator sets only
 * for emoji where a naive modifier append reproduces emojibase's own light-skin
 * variant — i.e. exactly the cases this append-based `applySkinTone` handles
 * correctly (ZWJ sequences are excluded). Membership ignores the variation
 * selector so a caller's `🖐️`/`🖐` and `👍️`/`👍` forms all resolve.
 *
 * #2671 — the dataset is now lazy-loaded (see `emoji-data.ts`), so this
 * module no longer imports it directly (that would just re-introduce the
 * eager ~150 KB payload one hop away). `computeTonableBases` is a pure
 * function the caller runs once against whatever `EmojiEntry[]` it already
 * has resolved (the browse-grid `<EmojiPicker>`, which awaits
 * `loadEmojiDataset()` itself); `supportsSkinTone`/`applySkinTone` take the
 * resulting set as a parameter instead of reading a module-scope constant.
 */

import type { EmojiEntry } from '@/editor/emoji-data'

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

/** Strip every variation selector so toned/untoned forms compare equal. */
function stripVariationSelector(char: string): string {
  return char.replace(/\u{FE0F}/gu, '')
}

/**
 * Tonable base glyphs (variation-selector-stripped) sourced from the dataset's
 * `skin` flag. Pure — call once against a resolved `EmojiEntry[]` and hold the
 * result (e.g. `useMemo`); cheap enough (~1900 entries) to not need its own
 * cache here on top of the caller's.
 */
export function computeTonableBases(entries: readonly EmojiEntry[]): ReadonlySet<string> {
  return new Set(entries.filter((e) => e.skin).map((e) => stripVariationSelector(e.char)))
}

/** Whether `char` accepts a Fitzpatrick skin-tone modifier, given the tonable-base set. */
export function supportsSkinTone(char: string, tonable: ReadonlySet<string>): boolean {
  return tonable.has(stripVariationSelector(char))
}

/**
 * Apply the given skin tone to `char`, returning the toned variant. Returns
 * `char` unchanged for the `default` tone or for bases that don't support
 * modifiers. Strips a trailing variation selector before appending the
 * modifier (the modifier supplies emoji presentation on its own).
 */
export function applySkinTone(
  char: string,
  tone: SkinToneId,
  tonable: ReadonlySet<string>,
): string {
  if (tone === 'default') return char
  if (!supportsSkinTone(char, tonable)) return char
  const modifier = SKIN_TONES.find((t) => t.id === tone)?.modifier ?? ''
  if (modifier === '') return char
  const base = char.replace(/\u{FE0F}$/u, '')
  return base + modifier
}
