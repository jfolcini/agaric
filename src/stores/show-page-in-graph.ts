/**
 * "Show in graph" (#5433): open the Graph view in local mode on the page in
 * the editor. One entry point for the page-actions menu, its shortcut and the
 * palette.
 */

import { t } from '@/lib/i18n'
import { notify } from '@/lib/notify'
import { PREFERENCES, readPreference, writePreference } from '@/lib/preferences'
import { useNavigationStore } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'
import { selectPageStack, useTabsStore } from '@/stores/tabs'

/**
 * GraphView seeds local mode from the active tab's top page and reads the
 * per-space mode on mount, so turning the mode on for the active space and
 * switching view is the whole action.
 */
export function showPageInGraph(): void {
  const hasPage = selectPageStack(useTabsStore.getState()).length > 0
  if (useNavigationStore.getState().currentView !== 'page-editor' || !hasPage) {
    notify.error(t('graph.local.noPage'))
    return
  }
  const { currentSpaceId } = useSpaceStore.getState()
  if (currentSpaceId == null) {
    notify.error(t('space.notReady'))
    return
  }
  const stored = readPreference(PREFERENCES.graphLocal, currentSpaceId)
  writePreference(PREFERENCES.graphLocal, { ...stored, active: true }, currentSpaceId)
  useNavigationStore.getState().setView('graph')
}
