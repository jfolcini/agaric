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
  setMode: (mode: JournalMode) => void
  setCurrentDate: (date: Date) => void
  navigateToDate: (date: Date, mode: JournalMode) => void
}

export const useJournalStore = create<JournalStore>((set) => ({
  mode: 'daily',
  currentDate: new Date(),
  setMode: (mode) => set({ mode }),
  setCurrentDate: (date) => set({ currentDate: date }),
  navigateToDate: (date, mode) => set({ currentDate: date, mode }),
}))
