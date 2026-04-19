import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { visualizer } from 'rollup-plugin-visualizer'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// Set `ANALYZE=1` (e.g. `ANALYZE=1 npm run build`) to emit a
// `dist/stats.html` bundle treemap from rollup-plugin-visualizer.
// `dist/` is gitignored, so the artefact never ships to the repo.
const analyze = process.env['ANALYZE'] === '1'

/**
 * Hand-rolled manual chunking — PERF-24.
 *
 * The single-bundle default pushed `index-*.js` past 1.8 MB raw, which
 * triggered Vite's 500 kB chunk-size warning on every build and slowed
 * first-paint parse time on Android/low-end devices. Grouping heavy
 * vendor libs into logical chunks:
 *
 *  - trims the entry chunk (smaller critical-path parse),
 *  - enables parallel chunk downloads (faster cold start),
 *  - lets the browser cache editor/highlight independently from app code
 *    (small app-only changes don't invalidate the big vendor chunks).
 *
 * Total payload is unchanged (and Tauri ships via local asset protocol
 * anyway). The win is parallelism + cache granularity + a clean build.
 */
function manualChunks(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined

  // Editor stack — only needed when a block is focused for editing, but
  // currently statically imported by the roving-editor pipeline. Keeping
  // it as a single chunk still wins because it parses in parallel with
  // the entry chunk instead of blocking it.
  if (
    id.includes('/@tiptap/') ||
    id.includes('/prosemirror-') ||
    id.includes('/linkifyjs/') ||
    id.includes('/rope-sequence/') ||
    id.includes('/w3c-keyname/')
  ) {
    return 'editor'
  }

  // Syntax highlighting — bundled via lowlight for code-block-lowlight.
  // highlight.js alone is ~260 kB of language grammars.
  if (id.includes('/lowlight/') || id.includes('/highlight.js/') || id.includes('/@wooorm/')) {
    return 'highlight'
  }

  // Drag-and-drop — only exercised in block trees and sortable lists.
  if (id.includes('/@dnd-kit/')) {
    return 'dnd'
  }

  // Date picker (calendar popover) — used by date properties and
  // journal date selection.
  if (id.includes('/react-day-picker/')) {
    return 'datepicker'
  }

  // Radix UI + floating-ui — overlay primitives. Bundled together because
  // Radix dialogs/popovers are pulled in by sonner toasts (confirm dialogs,
  // etc.), so splitting them further produces brittle chunk graphs.
  if (id.includes('/@radix-ui/') || id.includes('/@floating-ui/')) {
    return 'ui-radix'
  }

  // React + React-DOM — the unavoidable baseline. Extracted so a change
  // in app code doesn't invalidate this (long-term caching win).
  if (
    id.includes('/react-dom/') ||
    id.includes('/react/') ||
    id.includes('/scheduler/') ||
    id.includes('/react-i18next/') ||
    id.includes('/i18next/')
  ) {
    return 'react-vendor'
  }

  // d3-* (force, selection, drag, zoom, quadtree) — only exercised by
  // the graph-view simulation.
  if (id.includes('/d3-')) {
    return 'd3'
  }

  // Leave the remainder (lucide icons, match-sorter, sonner, date-fns,
  // @tanstack/react-virtual, zustand, fast-equals, etc.) in the entry
  // chunk. They're either tiny or needed on first paint.
  return undefined
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    ...(analyze
      ? [
          visualizer({
            filename: 'dist/stats.html',
            template: 'treemap',
            gzipSize: true,
            brotliSize: true,
          }),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    // Tauri ships WebKitGTK / WebView2 / WKWebView — all current platform
    // webviews understand ES2023 natively. Using a single uniform target
    // across desktop and mobile sidesteps an esbuild worker-pipeline bug
    // that mis-transforms destructuring on lower targets (safari13/14
    // 'Transforming destructuring … is not supported yet' on
    // discriminated-union narrowing in workers). WebView2 on Windows is
    // Chromium-based and evergreen; `es2023` is a subset it handles
    // natively, so we don't need the old `chrome105` override. Aligns the
    // runtime target with `tsconfig.app.json target: ES2023`, so what Vite
    // emits matches what the type-checker already assumes. Post-MAINT-84.
    target: 'es2023',
    minify: !process.env['TAURI_DEBUG'] ? 'esbuild' : false,
    sourcemap: !!process.env['TAURI_DEBUG'],
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
})
