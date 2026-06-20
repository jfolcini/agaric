/// <reference types="vite/client" />

// #1458: build-time flag set only for the e2e production build (`VITE_E2E=1
// vite build`). When set it keeps the tauri IPC mock in the bundle so the
// Playwright suite can run against `vite preview` instead of the HMR dev
// server; unset (and thus statically tree-shaken away) for normal releases.
// Augments vite's `ImportMetaEnv` (which already carries a string index
// signature) with an explicit, documented member.
interface ImportMetaEnv {
  readonly VITE_E2E?: string
}

interface Window {
  __TAURI_INTERNALS__?: Record<string, unknown>
}
