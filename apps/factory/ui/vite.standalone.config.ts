import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

// Standalone build of the settings/floor UI for the Electron app. Identical to
// vite.settings.config.ts except base: './' (so the emitted index.html references
// its assets relatively and loads over file:// in a BrowserWindow) and a separate
// outDir so the extension's webview bundle is never touched.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  root: 'settings',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'settings'),
      '@shared': resolve(__dirname, '../src/shared'),
    }
  },
  build: {
    outDir: '../../out/app-ui',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'settings/index.html'),
      output: {
        entryFileNames: 'main.js',
        assetFileNames: 'main.[ext]'
      },
      onwarn(warning, warn) {
        if (warning.code === 'MISSING_EXPORT') {
          const from = `${warning.exporter ?? ''} ${warning.message ?? ''}`
          if (from.includes('src/shared')) {
            throw new Error(`Rollup MISSING_EXPORT from shared contract: ${warning.message}`)
          }
          return
        }
        warn(warning)
      }
    }
  }
})
