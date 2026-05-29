/**
 * SpaceRowEditor — per-row orchestrator. PEND-30 D-2 reduced this from
 * a ~600-line monolith mixing five orthogonal concerns (rename,
 * accent, delete, journal-template, onboarding-hint) to a thin shell
 * composing four focused sub-components. The onboarding hint lifted
 * to a sibling at the dialog level rather than being recomputed per
 * row.
 *
 * Emptiness + journal-template state is owned by `SpaceManageDialog`
 * (MAINT-180) so the IPCs fire once per `space.id`, not once per row
 * mount.
 */

import type { SpaceRow } from '@/lib/tauri'

import { SpaceAccentPicker } from './SpaceAccentPicker'
import { SpaceDeleteBlockedHint, SpaceDeleteButton } from './SpaceDeleteButton'
import { SpaceJournalTemplateEditor } from './SpaceJournalTemplateEditor'
import { SpaceNameEditor } from './SpaceNameEditor'

export interface SpaceRowEditorProps {
  space: SpaceRow
  /** True when this is the only space — delete forbidden. */
  isLastSpace: boolean
  /** Refresh callback after a successful mutation. */
  onRefresh: () => Promise<void> | void
  /**
   * Emptiness probe result lifted to the parent (MAINT-180). `null` =
   * still loading or fetch failed → Delete stays disabled. `true` =
   * no pages, Delete enabled. `false` = ≥1 page, Delete disabled.
   */
  emptiness: boolean | null
  /**
   * Initial value of the per-space `journal_template` property,
   * fetched once per `space.id` by the parent (MAINT-180). `undefined`
   * = parent has not resolved yet → the journal-template editor is
   * not mounted (the loading seam is explicit at this gate, replacing
   * the old `journalTemplateInitializedRef` flag inside the editor).
   */
  initialJournalTemplate: string | undefined
  /**
   * Notify the parent so its cache reflects the new committed value,
   * and so a subsequent re-mount (dialog re-open) does not show stale
   * data from before this edit.
   */
  onJournalTemplateCommitted: (spaceId: string, value: string) => void
}

export function SpaceRowEditor({
  space,
  isLastSpace,
  onRefresh,
  emptiness,
  initialJournalTemplate,
  onJournalTemplateCommitted,
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
      <SpaceAccentPicker spaceId={space.id} />
      {initialJournalTemplate !== undefined && (
        <SpaceJournalTemplateEditor
          spaceId={space.id}
          initialValue={initialJournalTemplate}
          onCommitted={onJournalTemplateCommitted}
        />
      )}
    </div>
  )
}
