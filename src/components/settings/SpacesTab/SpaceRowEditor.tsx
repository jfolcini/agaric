/**
 * SpaceRowEditor — one Settings › Spaces row: rename, delete and accent.
 *
 * Emptiness state is owned by `SpacesTab` so the IPC fires once
 * per `space.id`, not once per row mount.
 */

import { SpaceAccentPicker } from '@/components/settings/SpacesTab/SpaceAccentPicker'
import {
  SpaceDeleteBlockedHint,
  SpaceDeleteButton,
} from '@/components/settings/SpacesTab/SpaceDeleteButton'
import { SpaceNameEditor } from '@/components/settings/SpacesTab/SpaceNameEditor'
import type { SpaceRow } from '@/lib/bindings'

export interface SpaceRowEditorProps {
  space: SpaceRow
  /** True when this is the only space — delete forbidden. */
  isLastSpace: boolean
  /** Refresh callback after a successful mutation. */
  onRefresh: () => Promise<void> | void
  /**
   * Emptiness probe result lifted to the parent. `null` =
   * still loading or fetch failed → Delete stays disabled. `true` =
   * no pages, Delete enabled. `false` = ≥1 page, Delete disabled.
   */
  emptiness: boolean | null
}

export function SpaceRowEditor({
  space,
  isLastSpace,
  onRefresh,
  emptiness,
}: SpaceRowEditorProps): React.JSX.Element {
  return (
    <div data-slot="space-manage-row" className="flex flex-col gap-2 border-b py-3 last:border-b-0">
      <div className="flex items-center gap-2">
        <SpaceNameEditor spaceId={space.id} spaceName={space.name} onRefresh={onRefresh} />
        <SpaceDeleteButton
          spaceId={space.id}
          spaceName={space.name}
          isLastSpace={isLastSpace}
          emptiness={emptiness}
          onRefresh={onRefresh}
        />
      </div>
      <SpaceDeleteBlockedHint emptiness={emptiness} isLastSpace={isLastSpace} />
      <SpaceAccentPicker spaceId={space.id} initialAccent={space.accent_color} />
    </div>
  )
}
