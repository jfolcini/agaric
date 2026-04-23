/**
 * Recent-pages store — Zustand state for the desktop-only "Recently visited"
 * strip (FEAT-9).
 *
 * Tracks up to `MAX_RETAINED` recent page visits in MRU order. Visits are
 * recorded by `useNavigationStore.navigateToPage`, the single entry point
 * for page navigation. Re-visiting the same pageId moves the existing entry
 * to the front (MRU dedup) and uses the new title, so stored titles always
 * reflect the most recent navigation.
 *
 * Global v1 — a single list shared across tabs/spaces. FEAT-3 phase 3 will
 * refactor to per-space later.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface PageRef {
  pageId: string
  title: string
}

/**
 * How many recent visits are retained in the store. The UI renders a
 * responsive subset via CSS grid (`auto-fit` minmax(120px, 180px)) but keeps
 * a deeper list in memory so viewport width changes don't surprise the user
 * with vanished entries.
 */
const MAX_RETAINED = 10

interface RecentPagesState {
  recentPages: PageRef[]
  recordVisit: (pageRef: PageRef) => void
  clear: () => void
}

export const useRecentPagesStore = create<RecentPagesState>()(
  persist(
    (set) => ({
      recentPages: [],
      recordVisit: (ref) =>
        set((state) => {
          const filtered = state.recentPages.filter((p) => p.pageId !== ref.pageId)
          // MRU: new visit moves to front, cap at MAX_RETAINED.
          return { recentPages: [ref, ...filtered].slice(0, MAX_RETAINED) }
        }),
      clear: () => set({ recentPages: [] }),
    }),
    {
      name: 'agaric:recent-pages',
      partialize: (state) => ({ recentPages: state.recentPages }),
    },
  ),
)
