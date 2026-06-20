/**
 * Shared sidebar navigation manifest.
 *
 * Extracted from `App.tsx` so both the sidebar JSX
 * (`AppSidebar`) and the header-label hook (`useHeaderLabel` in
 * `App.tsx`) can read the same source of truth without forcing a
 * circular import between the two modules.
 *
 * #1741 — the items are now bucketed into labeled groups (Workspace /
 * System) so the sidebar renders as grouped sections rather than one
 * flat 11-item list, mirroring SettingsView's `TAB_GROUPS`. Settings is
 * pulled out as `SETTINGS_NAV_ITEM` and rendered in the footer alongside
 * the other utility actions. `NAV_ITEMS` remains a flat export of every
 * destination (the grouped items plus Settings) so the existing
 * lookups in `useHeaderLabel` / `ViewDispatcher` — which `.find()` by id
 * regardless of order — keep working unchanged.
 */

import {
  Activity,
  Calendar,
  FileText,
  History,
  LayoutTemplate,
  Network,
  Search,
  Settings,
  SlidersHorizontal,
  Tag,
  Trash2,
} from 'lucide-react'
import type React from 'react'

import type { View } from '@/stores/navigation'

export interface NavItem {
  id: Exclude<View, 'page-editor'>
  icon: React.ElementType
  labelKey: string
}

export interface NavGroup {
  /** Stable id used for the section wiring (aria-labelledby / keys). */
  id: string
  /** i18n key for the section header label. */
  labelKey: string
  items: NavItem[]
}

/**
 * Grouped sidebar nav — primary workspace surfaces vs. system/utility
 * destinations. `page-editor` is not listed (navigated to programmatically),
 * and Settings lives in the footer (see `SETTINGS_NAV_ITEM`).
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'workspace',
    labelKey: 'sidebar.groupWorkspace',
    items: [
      { id: 'journal', icon: Calendar, labelKey: 'sidebar.journal' },
      { id: 'pages', icon: FileText, labelKey: 'sidebar.pages' },
      { id: 'search', icon: Search, labelKey: 'sidebar.search' },
      { id: 'tags', icon: Tag, labelKey: 'sidebar.tags' },
      { id: 'graph', icon: Network, labelKey: 'sidebar.graph' },
      { id: 'templates', icon: LayoutTemplate, labelKey: 'sidebar.templates' },
      { id: 'query', icon: SlidersHorizontal, labelKey: 'sidebar.query' },
    ],
  },
  {
    id: 'system',
    labelKey: 'sidebar.groupSystem',
    items: [
      { id: 'status', icon: Activity, labelKey: 'sidebar.status' },
      { id: 'history', icon: History, labelKey: 'sidebar.history' },
      { id: 'trash', icon: Trash2, labelKey: 'sidebar.trash' },
    ],
  },
]

/** Settings — rendered in the sidebar footer rather than the main nav (#1741). */
export const SETTINGS_NAV_ITEM: NavItem = {
  id: 'settings',
  icon: Settings,
  labelKey: 'sidebar.settings',
}

/**
 * Flat list of every nav destination (grouped items + Settings). Kept as a
 * single array so id-keyed lookups (`useHeaderLabel`, `ViewDispatcher`) work
 * regardless of how the sidebar groups them visually.
 */
export const NAV_ITEMS: NavItem[] = [
  ...NAV_GROUPS.flatMap((group) => group.items),
  SETTINGS_NAV_ITEM,
]
