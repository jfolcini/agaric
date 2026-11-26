import { PREFERENCES, usePreference } from '@/lib/preferences'
import { migrateTagColors, tagColorStyle } from '@/lib/tag-colors'
import { useResolveStore } from '@/stores/resolve'

/**
 * The inline style that paints a tag's chip in the tag's synced colour, else
 * the colour this device set; `undefined` for an uncoloured tag. A hook, so the
 * chip repaints when that colour changes, however its caller memoizes the tree.
 */
export function useTagColorStyle(tagId: string): ReturnType<typeof tagColorStyle> {
  const syncedColor = useResolveStore((s) => s.tagColors[tagId])
  const [tagColors] = usePreference(PREFERENCES.tagColors)
  // The raw read skips the #1099 legacy-hex migration `getTagColors` applies;
  // that one also writes back, which a render must not.
  return tagColorStyle(syncedColor ?? migrateTagColors(tagColors).colors[tagId])
}
