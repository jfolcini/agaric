/**
 * Navigation manifest: the views the app can route to, with their icon and
 * label. A data manifest (icon component *references* + labels/ids) rather
 * than a component, so it lives in `lib/` where the `hooks/` consumers
 * (`useAppSpaceLifecycle`, `useViewChangeAnnouncer`) can read it without
 * importing `components/` (lib-layering guard, #3121).
 *
 * #5269 — the sidebar lists the daily surfaces (`SIDEBAR_NAV_ITEMS`) and, at
 * the foot of its list, the views a day needs less often
 * (`SIDEBAR_LOWER_NAV_ITEMS`, #7155 R21) above its footer's Sync and
 * Settings. The other views are opened from the Pages header or a row in
 * Settings (Templates, Edit history); `NAV_ITEMS` carries every view, for
 * those buttons and for the header label, window title and view-change
 * announcement.
 */

import {
  Calendar,
  FileText,
  Funnel,
  History,
  LayoutTemplate,
  Network,
  Search,
  Settings,
  Tag,
  Trash2,
} from 'lucide-react'
import type React from 'react'

import type { View } from '@/types/view'

export interface NavItem {
  id: Exclude<View, 'page-editor'>
  icon: React.ElementType
  labelKey: string
}

/** The sidebar's main list. `page-editor` is navigated to programmatically. */
export const SIDEBAR_NAV_ITEMS: NavItem[] = [
  { id: 'journal', icon: Calendar, labelKey: 'sidebar.journal' },
  { id: 'pages', icon: FileText, labelKey: 'sidebar.pages' },
  { id: 'search', icon: Search, labelKey: 'sidebar.search' },
  { id: 'tags', icon: Tag, labelKey: 'sidebar.tags' },
]

/** The views at the foot of the sidebar's list, above its Sync and Settings rows. */
export const SIDEBAR_LOWER_NAV_ITEMS: NavItem[] = [
  { id: 'graph', icon: Network, labelKey: 'sidebar.graph' },
  { id: 'trash', icon: Trash2, labelKey: 'sidebar.trash' },
]

/** Settings — the sidebar footer's one nav destination. */
export const SETTINGS_NAV_ITEM: NavItem = {
  id: 'settings',
  icon: Settings,
  labelKey: 'sidebar.settings',
}

const VIEWS_OUTSIDE_SIDEBAR: NavItem[] = [
  { id: 'templates', icon: LayoutTemplate, labelKey: 'sidebar.templates' },
  { id: 'query', icon: Funnel, labelKey: 'sidebar.query' },
  { id: 'history', icon: History, labelKey: 'sidebar.history' },
]

/** Every routable view except `page-editor`, for id-keyed lookups. */
export const NAV_ITEMS: NavItem[] = [
  ...SIDEBAR_NAV_ITEMS,
  ...SIDEBAR_LOWER_NAV_ITEMS,
  ...VIEWS_OUTSIDE_SIDEBAR,
  SETTINGS_NAV_ITEM,
]
