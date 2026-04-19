import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
    // webviews understand ES2022 natively. Using a single uniform target
    // across desktop and mobile sidesteps an esbuild worker-pipeline bug
    // that mis-transforms destructuring on lower targets (safari13/14
    // 'Transforming destructuring … is not supported yet' on
    // discriminated-union narrowing in workers). WebView2 on Windows is
    // Chromium-based and evergreen; `es2022` is a subset it handles
    // natively, so we don't need the old `chrome105` override.
    target: 'es2022',
    minify: !process.env['TAURI_DEBUG'] ? 'esbuild' : false,
    sourcemap: !!process.env['TAURI_DEBUG'],
  },
})
