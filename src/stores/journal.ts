/**
 * Journal store — shared state for the journal view (mode, date, pageMap).
 *
 * Used by both App.tsx (header controls) and JournalPage.tsx (content).
 */

import { create } from 'zustand'

export type JournalMode = 'daily' | 'weekly' | 'monthly' | 'agenda'

interface JournalStore {
  mode: JournalMode
  currentDate: Date
  /** Date string (YYYY-MM-DD) to scroll into view after render, or null. */
  scrollToDate: string | null
  setMode: (mode: JournalMode) => void
  setCurrentDate: (date: Date) => void
  navigateToDate: (date: Date, mode: JournalMode) => void
  /** Set currentDate and request a scroll to a specific date section. */
  goToDateAndScroll: (date: Date, scrollTarget: string) => void
  clearScrollTarget: () => void
}

export const useJournalStore = create<JournalStore>((set) => ({
  mode: 'daily',
  currentDate: new Date(),
  scrollToDate: null,
  setMode: (mode) => set({ mode }),
  setCurrentDate: (date) => set({ currentDate: date }),
  navigateToDate: (date, mode) => set({ currentDate: date, mode }),
  goToDateAndScroll: (date, scrollTarget) => set({ currentDate: date, scrollToDate: scrollTarget }),
  clearScrollTarget: () => set({ scrollToDate: null }),
}))
