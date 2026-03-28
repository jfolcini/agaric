import { vi } from 'vitest'

// Shared mock for @tauri-apps/api/core — all component & store tests need this.
// Individual tests can override via vi.mocked(invoke).mockResolvedValueOnce(...)
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))
