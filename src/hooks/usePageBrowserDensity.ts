/**
 * `usePageBrowserDensity`.
 *
 * Owns the `density` preference for the Pages view's row chrome. Three
 * modes: `compact` (32 px row, title + relative time only), `regular`
 * (44 px row, full metadata badges — matches today's height), and
 * `expanded` (~68 px row, two-line content + all has-property badges).
 * Default `regular` to minimise visual disruption on first upgrade and
 * avoid a virtualizer re-measure storm.
 *
 * Mirror of `usePageBrowserSort`. Persists to localStorage under the
 * `page-browser-density` key; default `regular`. Independent of sort —
 * the two preferences never affect each other.
 */

import { useCallback } from 'react'

import { useLocalStoragePreference } from './useLocalStoragePreference'

export type DensityMode = 'compact' | 'regular' | 'expanded'

const DENSITY_STORAGE_KEY = 'page-browser-density'
const DEFAULT_DENSITY: DensityMode = 'regular'

const ALL_DENSITIES: ReadonlyArray<DensityMode> = ['compact', 'regular', 'expanded']

function parseDensity(raw: string): DensityMode {
  if ((ALL_DENSITIES as readonly string[]).includes(raw)) return raw as DensityMode
  throw new Error(`invalid density: ${raw}`)
}

function serializeDensity(value: DensityMode): string {
  return value
}

/**
 * Per-mode row height in pixels. Drives the virtualizer's
 * `estimateSize` callback so a density toggle correctly invalidates
 * the saved scroll offset.
 */
export const DENSITY_ROW_HEIGHT: Record<DensityMode, number> = {
  compact: 32,
  regular: 44,
  expanded: 68,
}

export interface UsePageBrowserDensityReturn {
  density: DensityMode
  setDensity: (value: DensityMode) => void
  /** Pixel height for the active density — for `estimateSize`. */
  rowHeight: number
}

export function usePageBrowserDensity(): UsePageBrowserDensityReturn {
  const [density, setDensityRaw] = useLocalStoragePreference<DensityMode>(
    DENSITY_STORAGE_KEY,
    DEFAULT_DENSITY,
    {
      parse: parseDensity,
      serialize: serializeDensity,
      source: 'usePageBrowserDensity',
    },
  )

  const setDensity = useCallback(
    (value: DensityMode) => {
      setDensityRaw(value)
    },
    [setDensityRaw],
  )

  return { density, setDensity, rowHeight: DENSITY_ROW_HEIGHT[density] }
}
