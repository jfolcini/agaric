/**
 * Thin backwards-compatibility shim over `./tauri-mock/index`.
 *
 * All implementation lives in the `./tauri-mock/` directory (seed data,
 * per-command handlers, error injection). This file remains so existing
 * consumers can `import … from './lib/tauri-mock'` without changes.
 */

export * from './tauri-mock/index'
