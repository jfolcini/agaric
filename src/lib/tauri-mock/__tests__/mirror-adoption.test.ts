/**
 * `set_mirror_folder` and an adopted folder (#6540, #6974): as the backend
 * (`adopt_tests.rs`), the adopted folder chosen again stays adopted, while
 * another folder or Turn off ends the adoption.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { dispatch } from '@/lib/tauri-mock/handlers'
import { seedBlocks } from '@/lib/tauri-mock/seed'

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const FOLDER = '/home/mock/Notes'

function adoptedSpace(status: unknown): unknown {
  return (status as { adopted_space: unknown }).adopted_space
}

describe('set_mirror_folder on an adopted folder (mock-internal)', () => {
  beforeEach(() => {
    seedBlocks()
    dispatch('adopt_mirror_folder', { folder: FOLDER, spaceId: 'space_a' })
  })

  it('keeps the adoption when the adopted folder is chosen again', () => {
    dispatch('set_mirror_folder', { path: FOLDER, readBack: true })

    expect(adoptedSpace(dispatch('get_mirror_status', {}))).toBe('SPACE_A')
  })

  it('ends the adoption when another folder is chosen', () => {
    dispatch('set_mirror_folder', { path: '/home/mock/Other', readBack: true })

    const status = dispatch('get_mirror_status', {}) as { folder: unknown }
    expect(adoptedSpace(status)).toBeNull()
    expect(status.folder).toBe('/home/mock/Other')
  })

  it('ends the adoption when the mirror is turned off', () => {
    dispatch('set_mirror_folder', { path: null, readBack: true })

    const status = dispatch('get_mirror_status', {}) as { folder: unknown }
    expect(adoptedSpace(status)).toBeNull()
    expect(status.folder).toBeNull()
  })
})
