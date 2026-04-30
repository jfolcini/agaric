/**
 * Shared sidebar navigation manifest.
 *
 * Extracted from `App.tsx` (MAINT-124 step 2) so both the sidebar JSX
 * (`AppSidebar`) and the header-label hook (`useHeaderLabel` in
 * `App.tsx`) can read the same source of truth without forcing a
 * circular import between the two modules.
 */

import {
  Activity,
  Calendar,
  FileText,
  GitMerge,
  History,
  LayoutTemplate,
  Network,
  Search,
  Settings,
  Tag,
  Trash2,
} from 'lucide-react'
import type React from 'react'
import type { View } from '../stores/navigation'

export interface NavItem {
  id: Exclude<View, 'page-editor'>
  icon: React.ElementType
  labelKey: string
}

/** Sidebar nav items — page-editor is not listed here (it's navigated to programmatically). */
export const NAV_ITEMS: NavItem[] = [
  { id: 'journal', icon: Calendar, labelKey: 'sidebar.journal' },
  { id: 'search', icon: Search, labelKey: 'sidebar.search' },
  { id: 'pages', icon: FileText, labelKey: 'sidebar.pages' },
  { id: 'tags', icon: Tag, labelKey: 'sidebar.tags' },
  { id: 'settings', icon: Settings, labelKey: 'sidebar.settings' },
  { id: 'trash', icon: Trash2, labelKey: 'sidebar.trash' },
  { id: 'status', icon: Activity, labelKey: 'sidebar.status' },
  { id: 'conflicts', icon: GitMerge, labelKey: 'sidebar.conflicts' },
  { id: 'history', icon: History, labelKey: 'sidebar.history' },
  { id: 'templates', icon: LayoutTemplate, labelKey: 'sidebar.templates' },
  { id: 'graph', icon: Network, labelKey: 'sidebar.graph' },
]
