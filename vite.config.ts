import { createReadStream, realpathSync } from 'node:fs'
import path from 'node:path'

import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import { visualizer } from 'rollup-plugin-visualizer'
import { defineConfig, type Plugin } from 'vite'

// #1458: the Playwright e2e suite runs against a static `vite preview`
// production build (not the HMR dev server, which stalled under shard load and
// cascaded a random shard to the CI job cap). One spec — `pdfjs-v6-smoke` —
// imports the pdfjs *API* module straight from `/node_modules/pdfjs-dist/
// build/pdf.min.mjs`, a URL only the DEV server serves; `vite preview` serves
// `dist/` alone, so that import 404s under preview. Rather than ship a 447 kB
// dev-only artifact into every release `public/` (the worker is genuinely
// needed at runtime; this API module is not — the app bundles `pdfjs-dist`),
// this preview-only middleware maps that exact URL to the real node_modules
// file. It is wired ONLY when `VITE_E2E=1` (the e2e build), so normal `npm run
// preview` / releases are untouched, and the spec stays byte-for-byte
// unchanged (its asserted behaviour — worker/API version match, real raster —
// is what we want to verify against the prod build).
function e2ePdfjsPreviewAsset(): Plugin {
  const URL_PATH = '/node_modules/pdfjs-dist/build/pdf.min.mjs'
  const realFile = path.resolve(
    realpathSync(path.resolve(__dirname, 'node_modules')),
    'pdfjs-dist/build/pdf.min.mjs',
  )
  return {
    name: 'e2e-pdfjs-preview-asset',
    apply: 'serve',
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        // Ignore any query string (`?import`, cache-busters) when matching.
        if (req.url && req.url.split('?')[0] === URL_PATH) {
          res.setHeader('Content-Type', 'text/javascript')
          createReadStream(realFile).pipe(res)
          return
        }
        next()
      })
    },
  }
}

// https://vite.dev/config/
// Set `ANALYZE=1` (e.g. `ANALYZE=1 npm run build`) to emit a
// `dist/stats.html` bundle treemap from rollup-plugin-visualizer.
// `dist/` is gitignored, so the artefact never ships to the repo.
const analyze = process.env['ANALYZE'] === '1'

// #1458: set by `npm run build:e2e` / `preview:e2e`. Wires the pdfjs preview
// asset middleware below so the one dev-path-dependent spec keeps working
// against the static preview build. Never set for normal builds/releases.
const e2e = !!process.env['VITE_E2E']

// React Compiler (#887) — full-tree auto-memoization. The eval proved
// the codebase compiler-clean (healthcheck 469/469, 0 bails; TipTap
// NodeViews are vanilla DOM). `@vitejs/plugin-react` v6 runs on
// rolldown/oxc, so the compiler is wired via the `reactCompilerPreset`
// helper + `@rolldown/plugin-babel` (the v5 `react({ babel })` option no
// longer exists). The preset defaults to `compilationMode: 'infer'`
// (compile every component/hook) and `target: '19'`, which emits imports
// from React 19's built-in `react/compiler-runtime` — no
// `react-compiler-runtime` polyfill needed.
//
// REVERT TOGGLE: set `REACT_COMPILER=0` to disable in one shot (e.g.
// `REACT_COMPILER=0 npm run build`). Defaults to ON.
// OFF under Vitest: unit tests assert behavior (compiler-agnostic — the full suite passes
// identically with it on or off), and coverage must measure SOURCE lines, not the compiler's
// injected `_c(...)` memo-cache branches (generated code that otherwise drags branch/function
// coverage below the gate). The compiler IS exercised by the Playwright e2e suite (real
// vite dev/build output).
const reactCompiler = process.env['REACT_COMPILER'] !== '0' && !process.env['VITEST']

/**
 * Hand-rolled manual chunking —.
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
    // Scope babel (React Compiler) to component files only. The default
    // include matches all .ts files too; running babel over plain .ts emits
    // codegen (e.g. dropping disambiguating parens around `(x as T) ? a : b`)
    // that the dev server's vite:oxc transformer then fails to re-parse,
    // breaking every e2e run. .jsx/.tsx is where components/hooks live.
    ...(reactCompiler
      ? [babel({ include: /\.[jt]sx(?:$|\?)/, presets: [reactCompilerPreset()] })]
      : []),
    tailwindcss(),
    ...(e2e ? [e2ePdfjsPreviewAsset()] : []),
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
    // Allow Vite to serve files from the REAL `node_modules` directory even
    // when it is a symlink pointing outside the project root (the e2e/CI
    // worktree layout symlinks `node_modules` to the main checkout). Without
    // this, dev-server `/@fs/<realpath>/node_modules/...` asset requests — e.g.
    // KaTeX's `dist/fonts/*.woff2`, referenced by the bundled `katex.min.css`
    // (#1437) — are rejected with a 403 outside the FS allow-list. Harmless in
    // a normal checkout (the realpath is the project's own node_modules) and
    // dev-server-only (production bundles these fonts into `dist/assets`).
    fs: {
      allow: [path.resolve(__dirname), realpathSync(path.resolve(__dirname, 'node_modules'))],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    // Tauri ships WebKitGTK / WebView2 / WKWebView — all current platform
    // webviews understand ES2023 natively. WebView2 on Windows is
    // Chromium-based and evergreen; `es2023` is a subset it handles
    // natively, so we don't need the old `chrome105` override. Aligns the
    // runtime target with `tsconfig.app.json target: ES2023`, so what Vite
    // emits matches what the type-checker already assumes.
    //
    // (historical): the single uniform target also sidestepped an
    // esbuild worker-pipeline bug at lower targets ('Transforming
    // destructuring … is not supported yet' on discriminated-union
    // narrowing inside workers). That bug class is structurally off the
    // Codepath now that Track B flipped the minifier to `'oxc'`
    // below, but the `es2023` target stays — it's minifier-independent
    // and the type-checker alignment alone is reason enough.
    target: 'es2023',
    // Track B: Vite 8 already runs on Rolldown (oxc-transform +
    // oxc-resolver are on the build path); the minifier is the last
    // remaining non-OXC step in the pipeline. Vite 8 types
    // `BuildOptions.minify` as `boolean | 'oxc' | 'terser' | 'esbuild'`;
    // selecting `'oxc'` aligns the entire production build path with the
    // OXC toolchain. The esbuild worker-pipeline destructuring
    // bug class is structurally off the codepath under `oxc-minify`; the
    // `es2023` target rationale above is minifier-independent and still
    // applies.
    minify: !process.env['TAURI_DEBUG'] ? 'oxc' : false,
    sourcemap: !!process.env['TAURI_DEBUG'],
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
})
