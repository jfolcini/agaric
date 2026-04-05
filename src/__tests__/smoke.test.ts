/**
 * Module smoke tests — verify key exports are importable and shaped correctly.
 *
 * These tests do NOT exercise real IPC; they only check that the modules
 * load without errors and export the symbols the rest of the app depends on.
 */

import { describe, expect, it } from 'vitest'

describe('module smoke tests', () => {
  // ── Stores ───────────────────────────────────────────────────────────

  it('block store exports are importable', async () => {
    const mod = await import('../stores/blocks')
    expect(mod.useBlockStore).toBeDefined()
    expect(typeof mod.useBlockStore.getState).toBe('function')
  })

  it('page-block store exports are importable', async () => {
    const mod = await import('../stores/page-blocks')
    expect(mod.createPageBlockStore).toBeDefined()
    expect(typeof mod.createPageBlockStore).toBe('function')
    expect(mod.PageBlockContext).toBeDefined()
    expect(mod.pageBlockRegistry).toBeDefined()
  })

  it('navigation store exports are importable', async () => {
    const mod = await import('../stores/navigation')
    expect(mod.useNavigationStore).toBeDefined()
    expect(typeof mod.useNavigationStore.getState).toBe('function')
  })

  it('boot store exports are importable', async () => {
    const mod = await import('../stores/boot')
    expect(mod.useBootStore).toBeDefined()
    expect(typeof mod.useBootStore.getState).toBe('function')
  })

  // ── Tauri wrappers ──────────────────────────────────────────────────

  it('tauri wrapper exports key command functions', async () => {
    const mod = await import('../lib/tauri')
    expect(typeof mod.listBlocks).toBe('function')
    expect(typeof mod.createBlock).toBe('function')
    expect(typeof mod.editBlock).toBe('function')
    expect(typeof mod.deleteBlock).toBe('function')
    expect(typeof mod.moveBlock).toBe('function')
    expect(typeof mod.getBlock).toBe('function')
    expect(typeof mod.searchBlocks).toBe('function')
  })

  // ── Markdown serializer ─────────────────────────────────────────────

  it('markdown serializer parse and serialize are importable and callable', async () => {
    const mod = await import('../editor/markdown-serializer')
    expect(typeof mod.parse).toBe('function')
    expect(typeof mod.serialize).toBe('function')

    // Minimal round-trip sanity check
    const doc = mod.parse('Hello world')
    expect(doc).toBeDefined()
    expect(doc.type).toBe('doc')

    const md = mod.serialize(doc)
    expect(typeof md).toBe('string')
    expect(md).toContain('Hello world')
  })
})
